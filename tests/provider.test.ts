import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { harness, sessionConfig } from "./harness.js";
import {
  createMuseProvider,
  type ProviderDefaults,
} from "../server/provider.js";

async function setup(
  t: { after(fn: () => Promise<void>): void },
  defaults: ProviderDefaults = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "paseo-muse-test-"));
  const h = await harness({
    museBin: resolve("tests/fake-muse.mjs"),
    requestTimeoutMs: 2000,
    shutdownTimeoutMs: 200,
    ...defaults,
  });
  t.after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = {
    ...sessionConfig(dir),
    env: {
      FAKE_MUSE_STORE: dir,
      FAKE_MUSE_AUDIT: join(dir, "audit"),
      MUSE_TEST_ENV: "overlay",
    },
  };
  const open = () =>
    h.request({
      type: "session.open",
      requestId: "open",
      sessionId: "s",
      config,
      history: "skip",
    });
  const prompt = async (
    id: string,
    text: string,
    delivery: "auto" | "steer" = "auto",
  ) => {
    const after = h.events.length;
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: id,
        delivery,
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    return h.wait(
      (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
        e.type === "session.prompt_result" && e.clientMessageId === id,
      after,
    );
  };
  const terminal = (after = 0) =>
    h.wait(
      (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
        e.type === "session.turn" && e.state !== "started",
      after,
    );
  const audit = async () =>
    (await readFile(join(dir, "audit"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  return { ...h, dir, config, open, prompt, terminal, audit };
}
test("protocol negotiation refuses incompatible versions", async () => {
  await assert.rejects(
    createMuseProvider().connect({ versions: [99], capabilities: [] }),
    /protocol version/,
  );
});
test("real SDK subprocess: catalog, streamed snapshots, exact correlation, and launch env", async (t) => {
  const h = await setup(t);
  await h.request({ type: "catalog", requestId: "c", cwd: h.dir });
  await h.open();
  const result = await h.prompt("one", "hello");
  assert.equal(result.result.type, "turn");
  await h.terminal();
  const turns = h.events.filter((e) => e.type === "session.turn");
  assert.deepEqual(
    turns.map((e) => e.state),
    ["started", "completed"],
  );
  const assistants = h.events.filter(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  assert(assistants.length >= 2);
  assert.equal(new Set(assistants.map((e) => e.item.id)).size, 1);
  assert.equal(
    (assistants.at(-1)!.item as { text: string }).text,
    "hello world",
  );
  const users = h.events.filter(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" && e.item.type === "user_message",
  );
  assert.equal(new Set(users.map((e) => e.item.id)).size, 1);
  assert(
    users.every(
      (e) => e.item.type === "user_message" && e.item.clientMessageId === "one",
    ),
  );
  await h.connection.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: "one",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    },
  });
  // A retried clientMessageId is idempotent: it settles again with the same
  // result instead of being silently dropped (which would hang the daemon).
  const results = h.events.filter(
    (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
      e.type === "session.prompt_result",
  );
  assert.equal(results.length, 2);
  assert.deepEqual(results[1].result, results[0].result);
  const frames = await h.audit();
  const actualDir = await realpath(h.dir);
  assert(frames.every((f) => f.envProbe === "overlay" && f.cwd === actualDir));
});
test("queue admission never starts a queued turn; interrupt retracts queue and waits for terminal", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("slow", "slow");
  await h.prompt("queued", "hello");
  assert.equal(
    h.events.filter((e) => e.type === "session.turn" && e.state === "started")
      .length,
    1,
  );
  const after = h.events.length;
  await h.request({
    type: "session.interrupt",
    sessionId: "s",
    requestId: "stop",
  });
  assert(
    !h.events.slice(after).some(
      (e) =>
        e.type === "session.turn" &&
        e.state === "canceled" &&
        e.turnId ===
          (
            h.events.find((e) => e.type === "session.turn") as {
              turnId: string;
            }
          ).turnId,
    ),
  );
  await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" &&
      e.state === "canceled" &&
      h.events.filter(
        (e) => e.type === "session.turn" && e.state === "canceled",
      ).length === 2,
    after,
  );
});
test("steering targets the active turn and does not invent another started turn", async (t) => {
  const h = await setup(t);
  await h.open();
  const root = await h.prompt("root", "slow");
  const steer = await h.prompt("steer", "more", "steer");
  assert(
    steer.result.type === "steer" &&
      root.result.type === "turn" &&
      steer.result.turnId === root.result.turnId,
  );
  assert.equal(
    h.events.filter((e) => e.type === "session.turn" && e.state === "started")
      .length,
    1,
  );
});
test("rejected prompts and queued launch failures settle exactly once", async (t) => {
  const h = await setup(t);
  await h.open();
  assert.equal((await h.prompt("reject", "reject")).result.type, "failed");
  const after = h.events.length;
  await h.prompt("launch", "launch-failure");
  const terminal = await h.terminal(after);
  assert.equal(terminal.state, "failed");
  assert(
    !h.events
      .slice(after)
      .some((e) => e.type === "session.turn" && e.state === "started"),
  );
});
test("approval allow and deny use offered choices, preserve stage token, and await resolution", async (t) => {
  const h = await setup(t);
  await h.open();
  for (const behavior of ["allow", "deny"] as const) {
    const after = h.events.length;
    await h.prompt(behavior, "approval");
    const permission = await h.wait(
      (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
        e.type === "session.permission",
      after,
    );
    if (behavior === "allow") {
      await h.connection.send({
        type: "session.permission",
        sessionId: "s",
        permissionId: permission.request.id,
        response: { behavior: "allow", selectedActionId: "invented" },
      });
      await h.wait(
        (e): e is ProviderEvent =>
          e.type === "session.notice" && e.notice.severity === "error",
        after,
      );
      assert(!(await h.audit()).some((f) => f.method === "approval/decide"));
    }
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: permission.request.id,
      response: {
        behavior,
        selectedActionId: behavior === "allow" ? "allow-once" : "deny-once",
      },
    });
    await h.terminal(after);
    assert(
      h.events
        .slice(after)
        .some((e) => e.type === "session.permission_resolved"),
    );
  }
  const decisions = (await h.audit()).filter(
    (f) => f.method === "approval/decide",
  );
  assert.equal(decisions.length, 2);
  assert(decisions.every((f) => f.params.requirementId.sourceIndex === 0));
});
test("persistence pages full history before ready with stable item IDs and no historical turn starts", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("one", "hello");
  await h.terminal();
  const opening = h.events.find(
    (e): e is Extract<ProviderEvent, { type: "session.opened" }> =>
      e.type === "session.opened",
  )!;
  const oldItems = h.events
    .filter((e) => e.type === "timeline.item")
    .map((e) => e.item.id);
  await h.request({
    type: "session.close",
    requestId: "close",
    sessionId: "s",
  });
  const after = h.events.length;
  await h.request({
    type: "session.open",
    requestId: "resume",
    sessionId: "s",
    config: h.config,
    history: "replay",
    persistence: opening.persistence,
  });
  const replay = h.events.slice(after);
  assert(replay.some((e) => e.type === "timeline.item"));
  assert.equal(replay.at(-1)?.type, "session.ready");
  assert(!replay.some((e) => e.type === "session.turn"));
  assert(
    replay
      .filter((e) => e.type === "timeline.item")
      .every((e) => oldItems.includes(e.item.id)),
  );
  await h.request({
    type: "session.configure",
    requestId: "config",
    sessionId: "s",
    changes: {
      model: "other-model",
      mode: "denyUnmatched",
      thinkingOption: "high",
    },
  });
  assert(
    h.events.some(
      (e) =>
        e.type === "session.config" &&
        e.config.model === "other-model" &&
        e.config.mode === "denyUnmatched",
    ),
  );
});
test("SDK gap recovery projects recovered items and terminal without losing the live suffix", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("gap", "gap");
  await h.terminal();
  assert(
    h.events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text === "GAP_RECOVERED",
    ),
  );
});
test("host death settles active work; close while opening cannot leak a host", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("crash", "crash");
  assert.equal((await h.terminal()).state, "failed");
  await h.wait((e): e is ProviderEvent => e.type === "session.closed");
  const other = await harness({
    museBin: resolve("tests/fake-muse.mjs"),
    requestTimeoutMs: 2000,
    shutdownTimeoutMs: 100,
  });
  await other.connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "race",
    config: h.config,
    history: "skip",
  });
  await other.close();
  assert(!other.events.some((e) => e.type === "session.ready"));
});
test("unsupported launch semantics and image validation fail explicitly", async (t) => {
  const h = await setup(t);
  await assert.rejects(
    h.request({
      type: "session.open",
      requestId: "system",
      sessionId: "s",
      config: { ...h.config, systemPrompt: "system instructions" },
      history: "skip",
    }),
    /systemPrompt/,
  );
  await h.open();
  const after = h.events.length;
  await h.connection.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: "image",
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "image", mimeType: "image/png", data: "not valid" }],
      },
    },
  });
  const result = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
      e.type === "session.prompt_result",
    after,
  );
  assert.equal(result.result.type, "failed");
});
test("admission backpressure retries the same command ID without duplicate execution", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("pressure", "pressure");
  await h.terminal();
  const attempts = (await h.audit()).filter((f) => f.method === "turn/start");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].params.commandId, attempts[1].params.commandId);
  assert.equal(
    h.events.filter((e) => e.type === "session.turn" && e.state === "started")
      .length,
    1,
  );
});
test("server-request-only approval is presented and decided through the command lane", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("request-only", "approval request-only");
  const permission = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
      e.type === "session.permission",
  );
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: permission.request.id,
    response: { behavior: "deny", selectedActionId: "deny-once" },
  });
  await h.terminal();
  assert.equal(
    (await h.audit()).filter((f) => f.method === "approval/decide").length,
    1,
  );
});
test("startup deadline closes a hung host and makes its slot reusable", async (t) => {
  const h = await setup(t);
  await assert.rejects(
    h.request({
      type: "session.open",
      requestId: "hang",
      sessionId: "s",
      history: "skip",
      config: {
        ...h.config,
        env: { FAKE_MUSE_HANG_INIT: "1" },
        providerOptions: { requestTimeoutMs: 100 },
      },
    }),
    /timed out/,
  );
  await h.open();
});

test("concurrent prompt admissions cannot exceed the pending turn limit", async (t) => {
  const h = await setup(t);
  await h.open();
  const results = await Promise.all(
    Array.from({ length: 33 }, (_, i) => h.prompt(`burst-${i}`, "slow")),
  );
  assert.equal(results.filter((r) => r.result.type === "turn").length, 32);
  const rejected = results.filter((r) => r.result.type === "failed");
  assert.equal(rejected.length, 1);
  assert.match(
    rejected[0]!.result.type === "failed"
      ? rejected[0]!.result.error.message
      : "",
    /pending turn limit/,
  );
  assert.equal(
    (await h.audit()).filter((f) => f.method === "turn/start").length,
    32,
  );
});

test("native MCP default shows a notice and still permits a strict session override", async (t) => {
  const h = await setup(t, {
    unsupportedMcpStrategy: "use-muse-native-config",
  });
  const config = {
    ...h.config,
    mcpServers: {
      paseo: { type: "stdio" as const, command: "unused-host-tool" },
    },
  };
  await assert.rejects(
    h.request({
      type: "session.open",
      requestId: "strict-mcp",
      sessionId: "s",
      config: {
        ...config,
        providerOptions: { unsupportedMcpStrategy: "reject" },
      },
      history: "skip",
    }),
    /cannot inject Paseo MCP servers/,
  );
  await h.request({
    type: "session.open",
    requestId: "native-mcp",
    sessionId: "s",
    config,
    history: "skip",
  });
  assert(
    h.events.some(
      (e) => e.type === "session.notice" && e.notice.id === "native-mcp",
    ),
  );
  const start = (await h.audit()).find((f) => f.method === "session/start");
  assert(!("mcpServers" in start.params));
});
test("approval allow without selectedActionId falls back to the offered once approval", async (t) => {
  const h = await setup(t);
  await h.open();
  const after = h.events.length;
  await h.prompt("allow-generic", "approval");
  const permission = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
      e.type === "session.permission",
    after,
  );
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: permission.request.id,
    response: { behavior: "allow" },
  });
  await h.terminal(after);
  const decisions = (await h.audit()).filter(
    (f) => f.method === "approval/decide",
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].params.choiceId, "allow-once");
});
test("turn/retracted settles the turn as canceled and releases its admission slot", async (t) => {
  const h = await setup(t);
  await h.open();
  const after = h.events.length;
  const retracted = await h.prompt("retract", "retract");
  assert.equal(retracted.result.type, "turn");
  const turnId = (retracted.result as { turnId: string }).turnId;
  const terminal = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" && e.turnId === turnId && e.state !== "started",
    after,
  );
  assert.equal(terminal.state, "canceled");
  const next = await h.prompt("after-retract", "hello");
  assert.equal(next.result.type, "turn");
  await h.terminal(h.events.indexOf(next));
});
test("unsupported question settled before cancel lands does not fail the session", async (t) => {
  const h = await setup(t);
  await h.open();
  const after = h.events.length;
  await h.prompt("question-race", "question");
  const turn = await h.terminal(after);
  assert.equal(turn.state, "completed");
  assert(
    h.events.some(
      (e) => e.type === "session.notice" && e.notice.id.startsWith("question:"),
    ),
  );
  assert(!h.events.some((e) => e.type === "session.runtime_failed"));
  const cancels = (await h.audit()).filter(
    (f) => f.method === "userInput/cancel",
  );
  assert.equal(cancels.length, 1);
});
test("duplicate clientMessageId re-emits the remembered prompt_result without re-executing", async (t) => {
  const h = await setup(t);
  await h.open();
  const first = await h.prompt("dup", "hello");
  assert.equal(first.result.type, "turn");
  const turnId = (first.result as { turnId: string }).turnId;
  await h.terminal();
  const second = await h.prompt("dup", "hello");
  assert.equal(second.result.type, "turn");
  assert.equal((second.result as { turnId: string }).turnId, turnId);
  assert.notEqual(second, first);
  assert.equal(
    h.events.filter(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "dup",
    ).length,
    2,
  );
  assert.equal(
    (await h.audit()).filter((f) => f.method === "turn/start").length,
    1,
  );
});
test("resume settles a turn orphaned by a dead host without a Paseo start and keeps the session usable", async (t) => {
  const h = await setup(t);
  await h.open();
  const slow = await h.prompt("slow", "slow");
  assert.equal(slow.result.type, "turn");
  const slowTurn = (slow.result as { turnId: string }).turnId;
  await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" &&
      e.turnId === slowTurn &&
      e.state === "started",
  );
  const opening = h.events.find(
    (e): e is Extract<ProviderEvent, { type: "session.opened" }> =>
      e.type === "session.opened",
  )!;
  // Closing while the slow turn runs leaves turn/started with no terminal in
  // the durable log, exactly as a host that died mid-turn would.
  await h.request({
    type: "session.close",
    requestId: "close",
    sessionId: "s",
  });
  const after = h.events.length;
  await h.request({
    type: "session.open",
    requestId: "resume",
    sessionId: "s",
    config: h.config,
    history: "replay",
    persistence: opening.persistence,
  });
  const replay = h.events.slice(after);
  assert(!replay.some((e) => e.type === "session.turn"));
  const openedAt = replay.findIndex((e) => e.type === "session.opened");
  assert(openedAt >= 0);
  const orphaned = replay.findIndex(
    (e) =>
      e.type === "session.notice" &&
      e.notice.id === `orphaned-turn:${slowTurn}`,
  );
  assert(orphaned > openedAt);
  // The orphan must not block admission of fresh work on the new host.
  const before = h.events.length;
  const next = await h.prompt("after-orphan", "hello");
  assert.equal(next.result.type, "turn");
  const nextTurn = (next.result as { turnId: string }).turnId;
  const terminal = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" &&
      e.turnId === nextTurn &&
      e.state !== "started",
    before,
  );
  assert.equal(terminal.state, "completed");
  assert(
    !h.events
      .slice(after)
      .some((e) => e.type === "session.turn" && e.turnId === slowTurn),
  );
});
test("deny with interrupt records the denial and then stops the turn", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("deny-interrupt", "approval");
  const permission = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
      e.type === "session.permission",
  );
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: permission.request.id,
    response: {
      behavior: "deny",
      selectedActionId: "deny-once",
      interrupt: true,
    },
  });
  const terminal = await h.terminal();
  assert.equal(terminal.state, "canceled");
  const frames = await h.audit();
  const decides = frames
    .map((f, i) => (f.method === "approval/decide" ? i : -1))
    .filter((i) => i >= 0);
  const interrupts = frames
    .map((f, i) => (f.method === "turn/interrupt" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(decides.length, 1);
  assert.equal(interrupts.length, 1);
  assert(decides[0] < interrupts[0]);
});
test("steer with clearPendingPermissions denies the blocking approval before steering", async (t) => {
  const h = await setup(t);
  await h.open();
  await h.prompt("blocked", "approval");
  await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
      e.type === "session.permission",
  );
  const after = h.events.length;
  await h.connection.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: "clear",
      delivery: "steer",
      clearPendingPermissions: true,
      input: {
        type: "message",
        content: [{ type: "text", text: "never mind" }],
      },
    },
  });
  const result = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
      e.type === "session.prompt_result" && e.clientMessageId === "clear",
    after,
  );
  assert.equal(result.result.type, "steer");
  await h.wait(
    (e): e is ProviderEvent => e.type === "session.permission_resolved",
    after,
  );
  await h.terminal(after);
  const frames = await h.audit();
  const decides = frames
    .map((f, i) => (f.method === "approval/decide" ? i : -1))
    .filter((i) => i >= 0);
  const steers = frames
    .map((f, i) => (f.method === "turn/steer" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(decides.length, 1);
  assert.equal(steers.length, 1);
  assert.equal(frames[decides[0]].params.choiceId, "deny-once");
  assert(decides[0] < steers[0]);
});
test("a Muse host with an unknown schema fingerprint opens normally", async (t) => {
  const h = await setup(t);
  await h.request({
    type: "session.open",
    requestId: "drift",
    sessionId: "s",
    config: { ...h.config, env: { FAKE_MUSE_FINGERPRINT: "sha256:other" } },
    history: "skip",
  });
  assert(h.events.some((e) => e.type === "session.ready"));
  assert(
    !h.events.some(
      (e) => e.type === "session.notice" && e.notice.id === "schema",
    ),
  );
});
