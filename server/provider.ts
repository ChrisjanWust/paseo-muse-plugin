import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderRegistration,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  optionsSchema,
  persistenceSchema,
  modeSchema,
  reasoningSchema,
  modes,
  thinkingOptions,
  type MuseOptions,
} from "./config.js";
import { spawnHost, query, deadline } from "./msp.js";
import { modelCatalog } from "./mapping.js";
import { MuseSession, providerError } from "./muse-session.js";

type PromptResult = Extract<
  ProviderEvent,
  { type: "session.prompt_result" }
>["result"];
const MAX_REMEMBERED_PROMPTS = 512;
export const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "permission",
] as const;
export interface ProviderDefaults {
  unsupportedMcpStrategy?: MuseOptions["unsupportedMcpStrategy"];
  museBin?: string;
  serveArgs?: string[];
  maxHosts?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export function createMuseProvider(
  defaults: ProviderDefaults = {},
): ProviderRegistration & { dispose(): Promise<void> } {
  const connections = new Set<MuseProviderConnection>();
  const budget = { active: 0, max: defaults.maxHosts ?? 8 };
  return {
    id: "muse",
    label: "Meta Muse Code",
    description: "Native Muse Session Protocol provider",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1))
        throw new Error("Muse requires Paseo provider protocol version 1");
      const connection = new MuseProviderConnection(
        negotiateProviderCapabilities(
          request.capabilities,
          SUPPORTED_CAPABILITIES,
        ),
        defaults,
        () => connections.delete(connection),
        budget,
      );
      connections.add(connection);
      return connection;
    },
    async dispose() {
      await Promise.allSettled([...connections].map((c) => c.close()));
    },
  };
}
export class MuseProviderConnection implements ProviderConnection {
  readonly version = 1;
  private listeners = new Set<(e: ProviderEvent) => void>();
  private sessions = new Map<string, MuseSession>();
  private opening = new Map<string, Promise<void>>();
  private tasks = new Set<Promise<void>>();
  private closed = false;
  // Prompt idempotency: key -> last emitted prompt_result payload, or
  // undefined while the original send is still in flight. Paseo awaits exactly
  // one prompt_result per send, so a client retry of the same clientMessageId
  // must settle again with the remembered result instead of being dropped.
  private prompts = new Map<
    string,
    { sessionId: string; result?: PromptResult }
  >();
  private closing?: Promise<void>;
  private options: MuseOptions;
  constructor(
    readonly capabilities: readonly string[],
    private defaults: ProviderDefaults = {},
    private disposed = () => {},
    private budget = { active: 0, max: defaults.maxHosts ?? 8 },
  ) {
    const { maxHosts: _, ...options } = defaults;
    this.options = optionsSchema.parse(options);
  }
  onEvent(listener: (e: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private static promptKey(sessionId: string, clientMessageId: string) {
    return JSON.stringify([sessionId, clientMessageId]);
  }
  private emit = (event: ProviderEvent) => {
    if (event.type === "session.closed") {
      if (this.sessions.delete(event.sessionId)) this.budget.active--;
      // Paseo mints a fresh provider sessionId per open, so no retry for this
      // session can arrive after it closed; forget its prompt results.
      for (const [key, entry] of this.prompts)
        if (entry.sessionId === event.sessionId) this.prompts.delete(key);
    } else if (event.type === "session.prompt_result") {
      const key = MuseProviderConnection.promptKey(
        event.sessionId,
        event.clientMessageId,
      );
      const entry = this.prompts.get(key);
      if (entry) entry.result = event.result;
    }
    for (const listener of this.listeners)
      try {
        listener(event);
      } catch {
        console.error("[paseo-muse] Provider event listener failed");
      }
  };
  async send(input: ProviderInput): Promise<void> {
    if (this.closed) throw new Error("Muse provider is closed");
    if (input.type === "session.prompt") {
      const key = MuseProviderConnection.promptKey(
        input.sessionId,
        input.prompt.clientMessageId,
      );
      const known = this.prompts.get(key);
      if (known) {
        // Idempotent retry: never execute twice, but always settle. If the
        // original is still in flight it will emit exactly one result itself.
        if (known.result)
          this.emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: known.result,
          });
        return;
      }
      if (this.prompts.size >= MAX_REMEMBERED_PROMPTS)
        this.prompts.delete(this.prompts.keys().next().value!);
      this.prompts.set(key, { sessionId: input.sessionId });
    }
    // Dispatch immediately; don't keep the plugin IPC intake blocked on a model,
    // permission, or startup. Every outcome uses its provider event correlation.
    const task = this.dispatch(input).catch((error) => {
      if ("requestId" in input)
        this.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: providerError(error),
        });
      else if (input.type === "session.prompt")
        this.emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "failed", error: providerError(error) },
        });
      else if (input.type === "session.permission")
        this.emit({
          type: "session.notice",
          sessionId: input.sessionId,
          notice: {
            id: `permission:${input.permissionId}`,
            severity: "error",
            title: "Permission could not be applied",
            description: providerError(error).message,
          },
        });
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
  private reserve() {
    if (this.budget.active >= this.budget.max)
      throw new Error(
        "Muse host limit reached; close another session and retry",
      );
    this.budget.active++;
  }
  private async dispatch(input: ProviderInput) {
    requireProviderCapabilities(this.capabilities, input);
    if (input.type === "catalog") {
      this.reserve();
      let host: Awaited<ReturnType<typeof spawnHost>> | undefined;
      try {
        host = await spawnHost(
          this.options,
          input.cwd ?? process.cwd(),
          { ...process.env },
          false,
        );
        const models = modelCatalog(
          await deadline(
            query(host.connection, "model/list", {}),
            this.options.requestTimeoutMs,
            "Muse catalog",
          ),
        );
        if (!this.closed)
          this.emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models,
              modes,
              thinkingOptions,
              defaultModel: models.find((m) => m.isDefault)?.id,
              defaultMode: "promptUnmatched",
            },
          });
      } finally {
        await host?.close();
        this.budget.active--;
      }
      return;
    }
    if (input.type === "session.open") {
      if (
        this.sessions.has(input.sessionId) ||
        this.opening.has(input.sessionId)
      )
        throw new Error("Muse session is already open");
      const pending = this.open(input);
      this.opening.set(input.sessionId, pending);
      try {
        await pending;
      } finally {
        this.opening.delete(input.sessionId);
      }
      return;
    }
    if ("sessionId" in input) {
      // close may arrive while spawn is in flight. Join startup and then release
      // its host; connection.close also joins all admitted open operations.
      await this.opening.get(input.sessionId);
      const session = this.sessions.get(input.sessionId);
      if (input.type === "session.close") {
        if (session) {
          await session.close();
        }
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (!session) throw new Error("Muse session is not open");
      switch (input.type) {
        case "session.prompt":
          await session.prompt(input.prompt);
          return;
        case "session.permission":
          await session.permissionResponse(input.permissionId, input.response);
          return;
        case "session.interrupt":
          await session.interrupt();
          break;
        case "session.configure":
          await session.configure(input.changes);
          break;
        default:
          throw new Error(`Unsupported Muse operation: ${input.type}`);
      }
      this.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    throw new Error(`Unsupported Muse operation: ${input.type}`);
  }
  private async open(input: Extract<ProviderInput, { type: "session.open" }>) {
    const options = optionsSchema.parse({
      ...this.options,
      ...input.config.providerOptions,
    });
    if (
      input.config.systemPrompt?.trim() &&
      options.systemPromptStrategy === "reject"
    )
      throw new Error(
        'Muse MSP has no systemPrompt field. Use providerOptions.systemPromptStrategy="prepend-user-context" to explicitly supply user-level context.',
      );
    if (
      Object.keys(input.config.mcpServers).length &&
      options.unsupportedMcpStrategy === "reject"
    )
      throw new Error(
        'Muse MSP cannot inject Paseo MCP servers. Use providerOptions.unsupportedMcpStrategy="use-muse-native-config" to explicitly use Muse configuration.',
      );
    if (input.config.toolPolicy?.preapproved.length)
      throw new Error("Muse MSP cannot apply Paseo tool preapproval rules");
    if (Object.keys(input.config.settings).length)
      throw new Error("Unsupported Muse settings");
    if (input.config.mode) modeSchema.parse(input.config.mode);
    if (input.config.thinkingOption)
      reasoningSchema.parse(input.config.thinkingOption);
    if (input.persistence) {
      persistenceSchema.parse(input.persistence);
      if (!input.config.persist)
        throw new Error("Cannot resume a durable session with persist=false");
    }
    this.reserve();
    let session: MuseSession | undefined;
    let host: Awaited<ReturnType<typeof spawnHost>> | undefined;
    try {
      host = await spawnHost(
        options,
        input.config.cwd,
        { ...process.env, ...input.config.env },
        input.config.persist,
      );
      if (this.closed) throw new Error("Provider closed during Muse startup");
      session = new MuseSession(
        input.sessionId,
        host,
        options,
        input.config,
        this.emit,
        this.capabilities,
      );
      await session.open(input.requestId, input.persistence, input.history);
      if (this.closed) throw new Error("Provider closed during Muse startup");
      this.sessions.set(input.sessionId, session);
    } catch (error) {
      if (session) await session.close();
      else await host?.close();
      this.budget.active--;
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      // Close existing hosts first to unblock pending command admissions.
      await Promise.allSettled(
        [...this.sessions.values()].map((s) => s.close()),
      );
      await Promise.allSettled([...this.tasks]);
      await Promise.allSettled(
        [...this.sessions.values()].map((s) => s.close()),
      );
      this.sessions.clear();
      this.listeners.clear();
      this.disposed();
    })();
    return this.closing;
  }
}
