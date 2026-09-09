import {
  spawnMspConnection,
  EXPECTED_SCHEMA_FINGERPRINT,
  type Connection,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type * as MSP from "@muse-code/sdk/dist/src/msp.js";
import type { MuseOptions } from "./config.js";

export { EXPECTED_SCHEMA_FINGERPRINT };
export type { MSP };
type Commands = {
  "session/start": [MSP.SessionStartParams, MSP.SessionStartResult];
  "session/resume": [MSP.SessionResumeParams, MSP.SessionResumeResult];
  "session/setModel": [MSP.SessionSetModelParams, MSP.SessionSetModelResult];
  "session/setApprovalMode": [
    MSP.SessionSetApprovalModeParams,
    MSP.SessionSetApprovalModeResult,
  ];
  "turn/start": [MSP.TurnStartParams, MSP.TurnStartResult];
  "turn/steer": [MSP.TurnSteerParams, MSP.TurnSteerResult];
  "turn/interrupt": [MSP.TurnInterruptParams, MSP.TurnInterruptResult];
  "turn/unqueue": [MSP.TurnUnqueueParams, MSP.TurnUnqueueResult];
  "approval/decide": [MSP.ApprovalDecideParams, MSP.ApprovalDecideResult];
  "userInput/cancel": [MSP.UserInputCancelParams, MSP.UserInputCancelResult];
};
type Queries = {
  "model/list": [MSP.ModelListParams, MSP.ModelListResult];
  "session/read": [MSP.SessionReadParams, MSP.SessionReadResult];
  "view/page": [MSP.ViewPageParams, MSP.ViewPageResult];
  "approval/listPending": [
    MSP.ApprovalListPendingParams,
    MSP.ApprovalListPendingResult,
  ];
};
// The SDK transport deliberately exposes an open wire surface. Keep casts at this
// single boundary, with arguments/results composed from its generated schema.
export function command<K extends keyof Commands>(
  connection: Connection,
  method: K,
  params: Omit<Commands[K][0], "commandId">,
  commandId?: string,
): Promise<Commands[K][1]> {
  return connection.command(method, params, {
    commandId,
  }) as unknown as Promise<Commands[K][1]>;
}
export function query<K extends keyof Queries>(
  connection: Connection,
  method: K,
  params: Queries[K][0],
): Promise<Queries[K][1]> {
  return connection.request(method, { ...params }) as unknown as Promise<
    Queries[K][1]
  >;
}
export async function deadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function spawnHost(
  options: MuseOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
  persist: boolean,
): Promise<SpawnedMspConnection> {
  if (options.serveArgs.includes("--no-session-log") && persist)
    throw new Error("persist=true conflicts with --no-session-log");
  const handshake = spawnMspConnection({
    command: options.museBin,
    args: [
      "serve",
      ...options.serveArgs,
      ...(!persist && !options.serveArgs.includes("--no-session-log")
        ? ["--no-session-log"]
        : []),
    ],
    cwd,
    env,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    // SDK drains stderr continuously. Do not mirror potentially private host diagnostics.
  });
  try {
    const host = await deadline(
      handshake.initialize({
        clientInfo: { name: "paseo_muse", version: "0.1.0" },
      }),
      options.requestTimeoutMs,
      "Muse initialize",
    );
    if (
      host.initializeResult.schema.fingerprint !==
        EXPECTED_SCHEMA_FINGERPRINT &&
      options.schemaMismatch === "fail"
    ) {
      throw new Error(
        `Unsupported MSP schema ${host.initializeResult.schema.fingerprint}; expected ${EXPECTED_SCHEMA_FINGERPRINT}`,
      );
    }
    if (
      persist &&
      host.initializeResult.sessionDurability &&
      host.initializeResult.sessionDurability !== "durable"
    )
      throw new Error("Muse host does not support durable sessions");
    return host;
  } catch (error) {
    await handshake.close();
    throw error;
  }
}
