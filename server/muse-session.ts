import {
  Session,
  readSessionDurability,
  MspError,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type {
  ProviderEvent,
  ProviderSessionConfig,
  ProviderPrompt,
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderPersistence,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import {
  command,
  query,
  deadline,
  EXPECTED_SCHEMA_FINGERPRINT,
  type MSP,
} from "./msp.js";
import {
  modeSchema,
  modes,
  reasoningSchema,
  thinkingOptions,
  persistenceSchema,
  type MuseOptions,
} from "./config.js";
import {
  displayText,
  modelCatalog,
  projectItem,
  toMuseInput,
} from "./mapping.js";
import { PermissionBroker } from "./permissions.js";

type WireEvent = { method: string; params?: unknown };
type TurnState = "started" | "completed" | "failed" | "canceled";
export class MuseSession {
  private session!: Session;
  private native!: MSP.Session;
  private opening = true;
  private buffer: WireEvent[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private snapshots = new Map<string, string>();
  private turnStates = new Map<string, TurnState>();
  private commandMessages = new Map<string, string>();
  private promptIds = new Set<string>();
  private admissions = 0;
  private starts = new Set<string>();
  private admittedTurns = new Set<string>();
  private config!: ProviderConfigState;
  private configSignature = "";
  private permission: PermissionBroker;
  private unsupportedQuestions = new Set<string>();
  private usageSignature = "";
  private replaying = false;

  constructor(
    readonly id: string,
    private host: SpawnedMspConnection,
    private options: MuseOptions,
    private launch: ProviderSessionConfig,
    private emit: (e: ProviderEvent) => void,
    private negotiated: readonly string[],
  ) {
    this.permission = new PermissionBroker(id, emit);
    host.connection.onNotification((e) => this.receive(e));
    host.connection.onProtocolError(() =>
      this.fail(new Error("Malformed Muse protocol stream")),
    );
    host.connection.onServerRequest(async (request) => {
      // The stable host uses notifications. A presentation request, if emitted,
      // is acknowledged only; approval/decide remains the decision lane.
      if (
        request.method === "approval/request" ||
        request.method === "userInput/request"
      ) {
        this.receive({
          method:
            request.method === "approval/request"
              ? "approval/requested"
              : "userInput/requested",
          params: request.params,
        });
        return {};
      }
      throw new Error(`Unsupported Muse server request: ${request.method}`);
    });
    void host.connection.closed.then(() => {
      if (!this.closed)
        this.fail(
          new Error(
            "Muse transport closed unexpectedly; reopen to reconcile durable state",
          ),
        );
    });
    void host.child.exit.then((exit) => {
      if (!this.closed)
        this.fail(
          new Error(
            `Muse host exited (${exit.kind}); reopen to reconcile durable state`,
          ),
        );
    });
  }
  private async io<T>(work: Promise<T>, label: string): Promise<T> {
    try {
      return await deadline(work, this.options.requestTimeoutMs, label);
    } catch (error) {
      if (!(error instanceof MspError)) this.fail(error);
      throw error;
    }
  }
  async open(
    requestId: string,
    persistence: ProviderPersistence | undefined,
    history: "replay" | "skip",
  ) {
    const saved = persistence
      ? persistenceSchema.parse(persistence)
      : undefined;
    if (
      saved &&
      saved.data.schemaFingerprint !==
        this.host.initializeResult.schema.fingerprint &&
      this.options.schemaMismatch === "fail"
    )
      throw new Error("Persisted session uses a different MSP schema");
    const result = saved
      ? await this.io(
          command(this.host.connection, "session/resume", {
            sessionId: saved.data.museSessionId,
            excludeItems: true,
          }),
          "Muse resume",
        )
      : await this.io(
          command(this.host.connection, "session/start", {
            workspaceRoot: this.launch.cwd,
            approvalMode: modeSchema.parse(
              this.launch.mode ?? "promptUnmatched",
            ),
            ...(this.launch.model ? { modelId: this.launch.model } : {}),
          }),
          "Muse start",
        );
    this.native = result.session;
    if (
      this.native.workspaceRoot &&
      this.native.workspaceRoot !== this.launch.cwd
    )
      throw new Error("Restored Muse workspace differs from the requested cwd");
    // This installed host can acknowledge ephemeral work without a session view.
    // Refuse that unimplemented runtime surface instead of leaving Paseo running forever.
    if (result.viewCursor.startsWith("pending:"))
      throw new Error(
        "This Muse build does not implement the requested session view (use durable sessions)",
      );
    this.session = new Session({
      sessionId: this.native.sessionId,
      connection: this.host.connection,
      durability: readSessionDurability(this.host.initializeResult),
    });
    this.session.onGapError(() =>
      this.fail(
        new Error("Muse history gap recovery failed; reopen the session"),
      ),
    );
    const models = modelCatalog(
      await this.io(
        query(this.host.connection, "model/list", {
          sessionId: this.native.sessionId,
        }),
        "Muse models",
      ),
    );
    this.config = {
      models,
      modes,
      thinkingOptions,
      settings: [],
      model: this.native.modelId ?? undefined,
      mode: this.native.approvalMode?.mode,
      thinkingOption: this.launch.thinkingOption,
    };
    if (saved) {
      // Page actual durable notifications: the SDK has no snapshot-seeding facade.
      // Stop at the resume head by opaque equality; buffer all live suffix frames.
      await this.replayTo(result.viewCursor);
      for (const turn of this.session.fold.turns())
        if (turn.state !== "running")
          this.turnStates.set(
            turn.turnId,
            this.terminal(String(turn.terminal)),
          );
      if (this.launch.model && this.launch.model !== this.config.model)
        await this.configureNative({ model: this.launch.model });
      if (this.launch.mode && this.launch.mode !== this.config.mode)
        await this.configureNative({ mode: this.launch.mode });
    }
    if (this.closed) throw new Error("Session closed during open");
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: this.capabilities(),
      restoration: "core",
      cwd: this.native.workspaceRoot ?? this.launch.cwd,
      ...(this.launch.persist
        ? {
            persistence: {
              version: 1,
              data: {
                museSessionId: this.native.sessionId,
                schemaFingerprint:
                  this.host.initializeResult.schema.fingerprint,
              },
            },
          }
        : {}),
    });
    this.emitConfig();
    if (saved && history === "replay") this.projectItems();
    else if (saved) this.projectItems(false);
    this.opening = false;
    for (const event of this.buffer.splice(0)) this.apply(event);
    this.reconcile();
    if (this.closed)
      throw new Error("Muse failed while opening its session view");
    if (this.launch.systemPrompt)
      this.notice(
        "system-context",
        "Paseo system prompt is supplied as user context; Muse system instructions retain precedence.",
      );
    if (Object.keys(this.launch.mcpServers).length)
      this.notice(
        "native-mcp",
        "Paseo MCP servers were not injected. This session uses Muse’s native MCP configuration.",
      );
    if (
      this.host.initializeResult.schema.fingerprint !==
      EXPECTED_SCHEMA_FINGERPRINT
    )
      this.notice(
        "schema",
        "MSP schema differs from the tested version. Compatibility is unverified.",
      );
    this.emit({ type: "session.ready", requestId, sessionId: this.id });
  }
  capabilities() {
    return this.negotiated.filter(
      (c) => c !== "session.persistence" || this.launch.persist,
    );
  }
  private async replayTo(head: string) {
    this.replaying = true;
    try {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let pageCount = 0; pageCount < 10000; pageCount++) {
        const page = await this.io(
          query(this.host.connection, "view/page", {
            sessionId: this.native.sessionId,
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          }),
          "Muse history",
        );
        for (const event of page.events) {
          this.session.apply(event);
          if (event.params.viewCursor === head) {
            this.readConfig();
            return;
          }
        }
        if (!page.nextCursor) {
          this.readConfig();
          return;
        }
        if (cursors.has(page.nextCursor))
          throw new Error("Muse history cursor did not advance");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error("Muse history exceeded the replay page limit");
    } finally {
      this.replaying = false;
    }
  }
  private receive(event: WireEvent) {
    if (this.closed) return;
    if (this.opening) {
      if (this.buffer.length >= 10000) {
        this.fail(new Error("Muse open event buffer exceeded its limit"));
        return;
      }
      this.buffer.push(event);
      return;
    }
    this.apply(event);
  }
  private apply(event: WireEvent) {
    if (this.closed) return;
    const params = event.params as { sessionId?: unknown } | undefined;
    if (params?.sessionId !== this.native.sessionId) return;
    try {
      const outcome = this.session.apply(event);
      if (event.method === "turn/started")
        this.starts.add((event.params as MSP.TurnStartedParams).turnId);
      // Preserve every actual start even if completion shares one stdout chunk.
      if (
        event.method === "turn/started" &&
        !this.admissions &&
        !this.opening &&
        this.session.fold.current
      )
        this.projectTurns();
      if (outcome.fold.kind === "deliveryGap")
        void outcome.io.then(() => this.schedule());
      this.schedule();
    } catch {
      this.fail(new Error(`Cannot fold Muse ${event.method} event`));
    }
  }
  private schedule() {
    if (this.scheduled || this.closed || this.opening || this.replaying) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.reconcile();
    }, 10);
  }
  private reconcile() {
    if (this.closed || this.opening || !this.session?.fold.current) return;
    try {
      this.readConfig();
      this.emitConfig();
      this.projectItems();
      if (!this.admissions) this.projectTurns();
      if (this.session.fold.pendingApprovals().length > 64)
        throw new Error("Muse pending permission limit exceeded (64)");
      this.permission.reconcile(this.session.fold.pendingApprovals());
      const tokens = this.session.fold.sessionState.get("session/tokenUsage");
      const context = this.session.fold.sessionState.get(
        "session/contextUsage",
      );
      const usage = {
        inputTokens: tokens?.cumulative.promptTokens,
        outputTokens: tokens?.cumulative.outputTokens,
        contextWindowUsedTokens: context?.usedTokens,
        contextWindowMaxTokens: context?.windowTokens,
      };
      const signature = JSON.stringify(usage);
      if (signature !== this.usageSignature && (tokens || context)) {
        this.usageSignature = signature;
        this.emit({ type: "session.usage", sessionId: this.id, usage });
      }
      const todo = this.session.fold.sessionState.get(
        "session/todoListChanged",
      );
      if (todo)
        this.snapshot({
          type: "todo",
          id: `muse:${this.native.sessionId}:todos`,
          items: todo.items.map((i) => ({
            text: i.text,
            completed: i.status === "completed",
            status:
              i.status === "inProgress"
                ? "in_progress"
                : i.status === "completed"
                  ? "completed"
                  : "pending",
          })),
        });
      for (const question of this.session.fold.pendingUserInputs())
        if (!this.unsupportedQuestions.has(question.userInputId)) {
          this.unsupportedQuestions.add(question.userInputId);
          this.notice(
            `question:${question.userInputId}`,
            "Muse requested a structured question this provider cannot yet render; the question was canceled.",
          );
          void this.io(
            command(this.host.connection, "userInput/cancel", {
              sessionId: this.native.sessionId,
              userInputId: question.userInputId,
              reason:
                "Paseo Muse provider does not support structured elicitation yet",
            }),
            "Cancel unsupported question",
          ).catch((e) => this.fail(e));
        }
    } catch (error) {
      this.fail(error);
    }
  }
  private snapshot(
    item: Extract<ProviderEvent, { type: "timeline.item" }>["item"],
    publish = true,
    timestamp?: string,
  ) {
    const signature = JSON.stringify(item);
    if (this.snapshots.get(item.id) === signature) return;
    this.snapshots.set(item.id, signature);
    if (publish)
      this.emit({
        type: "timeline.item",
        sessionId: this.id,
        item,
        ...(timestamp ? { timestamp } : {}),
      });
  }
  private projectItems(publish = true) {
    for (const item of this.session.fold.items.list())
      this.snapshot(
        projectItem(
          item,
          this.session.fold,
          this.native.sessionId,
          item.commandId ? this.commandMessages.get(item.commandId) : undefined,
        ),
        publish,
        item.recordedAt,
      );
  }
  private terminal(terminal?: string): TurnState {
    return terminal === "completed"
      ? "completed"
      : terminal === "cancelled"
        ? "canceled"
        : "failed";
  }
  private turn(
    turnId: string,
    state: TurnState,
    error?: { message: string; code?: string },
  ) {
    const previous = this.turnStates.get(turnId);
    if (previous === state || (previous && previous !== "started")) return;
    this.turnStates.set(turnId, state);
    this.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId,
      state,
      ...(error ? { error } : {}),
    });
    if (state !== "started") this.admittedTurns.delete(turnId);
  }
  private projectTurns() {
    for (const turn of this.session.fold.turns()) {
      if (
        this.starts.has(turn.turnId) ||
        (turn.commandId &&
          turn.state !== "unqueued" &&
          turn.state !== "retracted")
      )
        this.turn(turn.turnId, "started");
      if (turn.state === "running") this.turn(turn.turnId, "started");
      else if (turn.state === "unqueued" || turn.state === "retracted")
        this.turn(turn.turnId, "canceled");
      else if (turn.state === "settled")
        this.turn(
          turn.turnId,
          this.terminal(String(turn.terminal)),
          turn.error
            ? { message: turn.error.message, code: String(turn.error.kind) }
            : undefined,
        );
    }
  }
  private readConfig() {
    const model = this.session.fold.sessionState.get("session/modelChanged");
    const mode = this.session.fold.sessionState.get(
      "session/approvalModeChanged",
    );
    if (model) this.config.model = model.modelId;
    if (mode) this.config.mode = mode.mode;
  }
  private emitConfig() {
    const signature = JSON.stringify(this.config);
    if (signature === this.configSignature) return;
    this.configSignature = signature;
    this.emit({
      type: "session.config",
      sessionId: this.id,
      config: structuredClone(this.config),
    });
  }
  async prompt(prompt: ProviderPrompt) {
    if (this.closed || this.opening)
      throw new Error("Muse session is not ready");
    if (this.promptIds.has(prompt.clientMessageId)) return;
    this.promptIds.add(prompt.clientMessageId);
    this.admissions++;
    try {
      // Include commands still awaiting acknowledgement; concurrent sends all
      // enter here before any of their turn IDs have reached admittedTurns.
      if (this.admittedTurns.size + this.admissions > 32)
        throw new Error("Muse session has reached its pending turn limit (32)");
      if (prompt.input.type !== "message" || prompt.outputSchema !== undefined)
        throw new Error(
          "Muse supports message prompts without an output schema",
        );
      const input = toMuseInput(prompt.input.content);
      if (!input.length) throw new Error("Empty prompt");
      if (
        this.launch.systemPrompt &&
        this.options.systemPromptStrategy === "prepend-user-context"
      )
        input.unshift({
          type: "text",
          text: `Paseo-provided context (user-level, not Muse system instructions):\n${this.launch.systemPrompt}\n\n`,
        });
      const commandId = this.host.connection.mintCommandId();
      this.commandMessages.set(commandId, prompt.clientMessageId);
      const common = {
        sessionId: this.native.sessionId,
        input,
        ...(this.config.thinkingOption
          ? {
              reasoningEffort: reasoningSchema.parse(
                this.config.thinkingOption,
              ),
            }
          : {}),
      };
      let result: { turnId: string };
      if (prompt.delivery === "steer") {
        const active = this.session.fold.activeTurnId;
        if (!active) throw new Error("There is no active Muse turn to steer");
        result = await this.io(
          command(
            this.host.connection,
            "turn/steer",
            { ...common, expectedTurnId: active },
            commandId,
          ),
          "Muse steer",
        );
      } else {
        result = await this.io(
          command(
            this.host.connection,
            "turn/start",
            {
              ...common,
              ifBusy: "queue",
              displayText: displayText(prompt.input.content),
            },
            commandId,
          ),
          "Muse prompt",
        );
        if (!this.closed) this.admittedTurns.add(result.turnId);
      }
      if (this.closed)
        throw new Error(
          "Muse closed before prompt admission could be confirmed; reopen to reconcile the session",
        );
      this.snapshot({
        type: "user_message",
        id: `muse:${this.native.sessionId}:user:${commandId}`,
        text: displayText(prompt.input.content),
        clientMessageId: prompt.clientMessageId,
      });
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: prompt.delivery === "steer" ? "steer" : "turn",
          turnId: result.turnId,
        },
      });
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: providerError(error) },
      });
    } finally {
      this.admissions--;
      this.reconcile();
    }
  }
  async interrupt() {
    // Retract all queued admissions before interrupting the foreground turn.
    for (const id of [...this.admittedTurns])
      if (!this.session.fold.turn(id)) {
        try {
          await this.io(
            command(this.host.connection, "turn/unqueue", {
              sessionId: this.native.sessionId,
              turnId: id,
            }),
            "Muse unqueue",
          );
        } catch (error) {
          // The queued turn may have launched while the stop was in flight.
          // Only an observed state transition permits falling through to the
          // foreground interrupt; don't swallow other command failures.
          if (!(error instanceof MspError) || !this.session.fold.turn(id))
            throw error;
        }
      }
    const active = this.session.fold.activeTurnId;
    if (active)
      await this.io(
        command(this.host.connection, "turn/interrupt", {
          sessionId: this.native.sessionId,
          turnId: active,
        }),
        "Muse interrupt",
      );
  }
  async permissionResponse(id: string, response: ProviderPermissionResponse) {
    await this.permission.resolve(id, response, (params) =>
      this.io(
        command(this.host.connection, "approval/decide", {
          ...params,
          sessionId: this.native.sessionId,
        }),
        "Muse permission",
      ),
    );
  }
  private async configureNative(changes: ProviderConfigChanges) {
    if (changes.settings && Object.keys(changes.settings).length)
      throw new Error("Muse does not expose these settings");
    if (changes.model === null || changes.mode === null)
      throw new Error("Select an explicit model/mode; clearing is unsupported");
    if (changes.mode !== undefined) modeSchema.parse(changes.mode);
    if (changes.thinkingOption != null)
      reasoningSchema.parse(changes.thinkingOption);
    if (changes.model !== undefined) {
      if (!this.config.models.some((m) => m.id === changes.model))
        throw new Error("Unknown Muse model");
      await this.io(
        command(this.host.connection, "session/setModel", {
          sessionId: this.native.sessionId,
          model: { modelId: changes.model },
        }),
        "Muse model change",
      );
      // Verify committed metadata rather than echoing command admission.
      const read = await this.io(
        query(this.host.connection, "session/read", {
          sessionId: this.native.sessionId,
        }),
        "Muse effective model",
      );
      this.config.model = read.session.modelId ?? undefined;
      if (this.config.model !== changes.model)
        throw new Error("Muse has not committed the requested model yet");
    }
    if (changes.mode !== undefined) {
      const result = await this.io(
        command(this.host.connection, "session/setApprovalMode", {
          sessionId: this.native.sessionId,
          mode: modeSchema.parse(changes.mode),
        }),
        "Muse mode change",
      );
      this.config.mode = result.effectiveMode.mode;
    }
    if (changes.thinkingOption !== undefined)
      this.config.thinkingOption = changes.thinkingOption ?? undefined;
  }
  async configure(changes: ProviderConfigChanges) {
    try {
      await this.configureNative(changes);
    } finally {
      this.emitConfig();
    }
  }
  private notice(id: string, description: string) {
    this.emit({
      type: "session.notice",
      sessionId: this.id,
      notice: { id, severity: "warning", title: "Muse provider", description },
    });
  }
  fail(error: unknown) {
    if (this.closed) return;
    for (const [id, state] of this.turnStates)
      if (state === "started") this.turn(id, "failed", providerError(error));
    for (const id of this.admittedTurns)
      this.turn(id, "failed", providerError(error));
    this.emit({
      type: "session.runtime_failed",
      sessionId: this.id,
      error: providerError(error),
    });
    void this.close().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.scheduled);
    this.permission.clear();
    this.closing = (async () => {
      let clean = false;
      try {
        await this.host.close();
        clean = (await this.host.child.exit).kind === "cleanShutdown";
      } finally {
        const terminal = clean ? "canceled" : "failed";
        const error = clean
          ? undefined
          : {
              message:
                "Muse did not drain cleanly; reopen to reconcile durable state",
            };
        for (const [id, state] of this.turnStates)
          if (state === "started") this.turn(id, terminal, error);
        for (const id of this.admittedTurns) this.turn(id, terminal, error);
        this.emit({ type: "session.closed", sessionId: this.id });
      }
    })();
    return this.closing;
  }
}
export function providerError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof MspError ? { code: error.kind } : {}),
  };
}
