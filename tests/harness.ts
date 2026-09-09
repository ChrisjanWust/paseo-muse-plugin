import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  createMuseProvider,
  SUPPORTED_CAPABILITIES,
  type ProviderDefaults,
} from "../server/provider.js";
export async function harness(defaults: ProviderDefaults = {}) {
  const provider = createMuseProvider(defaults);
  const connection = await provider.connect({
    versions: [1],
    capabilities: SUPPORTED_CAPABILITIES,
  });
  const events: ProviderEvent[] = [];
  const listeners = new Set<() => void>();
  connection.onEvent((e) => {
    ProviderEventSchema.parse(e);
    events.push(e);
    for (const listener of listeners) listener();
  });
  const wait = <T extends ProviderEvent>(
    predicate: (e: ProviderEvent) => e is T,
    after = 0,
    timeout = 30000,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `Event timeout. Recent events: ${JSON.stringify(events.slice(-6))}`,
          ),
        );
      }, timeout);
      const check = () => {
        const event = events.slice(after).find(predicate);
        if (event) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(event);
        }
      };
      listeners.add(check);
      check();
    });
  return {
    provider,
    connection,
    events,
    wait,
    async request(input: Extract<ProviderInput, { requestId: string }>) {
      const after = events.length;
      await connection.send(input);
      const e = await wait(
        (e): e is ProviderEvent =>
          "requestId" in e &&
          e.requestId === input.requestId &&
          [
            "catalog",
            "session.ready",
            "request.completed",
            "request.failed",
          ].includes(e.type),
        after,
      );
      if (e.type === "request.failed") throw new Error(e.error.message);
      return e;
    },
    close: () => provider.dispose(),
  };
}
export const sessionConfig = (cwd: string) => ({
  cwd,
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
  mode: "promptUnmatched",
  thinkingOption: "low",
});
