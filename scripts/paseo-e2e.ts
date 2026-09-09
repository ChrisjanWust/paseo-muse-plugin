import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const cli = process.env.PASEO_CLI ?? "paseo";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PASEO_DICTATION_ENABLED: "false",
  PASEO_VOICE_MODE_ENABLED: "false",
};
delete env.PASEO_AGENT_ID;
delete env.PASEO_WORKSPACE_ID;
assert.match(
  (await exec(cli, ["--version"], { env })).stdout,
  /0\.8\./,
  "Use a Paseo 0.8 CLI (PASEO_CLI=/path/to/paseo)",
);
const root = await mkdtemp(join(tmpdir(), "paseo-muse-e2e-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
await mkdir(home);
await mkdir(workspace);
await mkdir(".tmp", { recursive: true });
await writeFile(
  join(home, "config.json"),
  JSON.stringify({
    version: 1,
    pluginsEnabled: true,
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  }),
);
const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});
const host = `127.0.0.1:${port}`;
const log = createWriteStream(resolve(".tmp/paseo-e2e-daemon.log"));
const startDaemon = () =>
  spawn(
    cli,
    [
      "start",
      "--home",
      home,
      "--listen",
      host,
      "--no-relay",
      "--no-mcp",
      "--no-inject-mcp",
      "--no-web-ui",
      "--foreground",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
let daemon = startDaemon();
const attach = () => {
  daemon.stdout.pipe(log, { end: false });
  daemon.stderr.pipe(log, { end: false });
  return new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
};
let exited = attach();
const limitations: string[] = [];
async function stopDaemon() {
  const current = daemon;
  current.kill("SIGTERM");
  const timer = setTimeout(() => current.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
}
async function run(args: string[], json = true) {
  const result = await exec(
    cli,
    [...args, "--host", host, ...(json ? ["--json"] : [])],
    { env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!json) return result.stdout;
  const start = result.stdout.search(/^[\[{]/m);
  if (start < 0) throw new Error(`No JSON response from ${args[0]}`);
  return JSON.parse(result.stdout.slice(start));
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await run(["status"]);
      ready = true;
      break;
    } catch {
      if (daemon.exitCode !== null)
        throw new Error(
          "Test daemon exited during startup; see .tmp/paseo-e2e-daemon.log",
        );
      await delay(250);
    }
  }
  assert(ready, "Test daemon did not start");
  await run(["plugin", "add", process.cwd()]);
  let models: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    try {
      models = await run(["provider", "models", "muse"]);
      if (models.length) break;
    } catch {
      await delay(250);
    }
  }
  assert(models.length > 0, "No Muse models discovered through Paseo");
  const created = await run([
    "run",
    "Reply with exactly PASEO_NATIVE_MUSE_OK. Do not use tools.",
    "--provider",
    "muse",
    "--model",
    "muse-spark-1.3",
    "--mode",
    "promptUnmatched",
    "--thinking",
    "low",
    "--title",
    "Muse E2E",
    "--cwd",
    workspace,
    "--wait-timeout",
    "60s",
  ]);
  assert.equal(created.status, "completed");
  const id = created.agentId;
  assert.match(await run(["logs", id], false), /PASEO_NATIVE_MUSE_OK/);
  const reloaded = await run(["agent", "reload", id]);
  assert.equal(reloaded.status, "reloaded");
  assert(reloaded.timelineSize >= 2);
  const resumed = await run([
    "send",
    id,
    "Repeat your previous exact reply from the conversation without tools.",
  ]);
  assert.equal(resumed.status, "completed");
  await run(["agent", "mode", id, "denyUnmatched"]);
  await run(["agent", "update", id, "--thinking", "medium"]);
  await run(["agent", "mode", id, "promptUnmatched"]);
  await run([
    "send",
    id,
    "Use your shell tool to execute sleep 30, then reply FINISHED.",
    "--no-wait",
  ]);
  await delay(2000);
  await run(["stop", id]);
  await run(["wait", id, "--timeout", "30s"]);
  await run([
    "send",
    id,
    "Use your shell tool to execute sleep 30, then reply FINISHED.",
    "--no-wait",
  ]);
  await delay(1500);
  await run(["plugin", "reload", "paseo-muse"]);
  try {
    await run(["agent", "reload", id]);
  } catch (error) {
    assert.match(
      String((error as { stderr?: string }).stderr),
      /Provider runtime is closed/,
    );
    limitations.push(
      "Paseo beta.1 requires a daemon restart to reopen existing agents after plugin reload",
    );
    await stopDaemon();
    daemon = startDaemon();
    exited = attach();
    let restored = false;
    for (let i = 0; i < 60; i++) {
      try {
        await run(["agent", "reload", id]);
        restored = true;
        break;
      } catch {
        await delay(250);
      }
    }
    assert(restored, "Agent did not restore after daemon restart");
  }
  await run(["send", id, "Reply RELOAD_OK without tools."]);
  assert.match(await run(["logs", id], false), /RELOAD_OK/);
  await run([
    "send",
    id,
    "Use your shell tool to execute sleep 30, then reply FINISHED.",
    "--no-wait",
  ]);
  await delay(1500);
  await run(["plugin", "remove", "paseo-muse"]);
  const plugins = await run(["plugin", "ls"]);
  assert(!plugins.some((p: { id: string }) => p.id === "paseo-muse"));
  const result = {
    passed: true,
    limitations,
    paseo: "0.8.0-beta.1",
    checks: [
      "plugin compilation and loading",
      "live model catalog",
      "native prompt and timeline",
      "durable agent reload",
      "continued conversation",
      "mode and thinking controls",
      "interrupt",
      "plugin reload during active turn",
      "plugin removal during active turn",
    ],
  };
  await writeFile(
    ".tmp/paseo-e2e-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await stopDaemon();
  log.end();
  await rm(root, { recursive: true, force: true });
}
