#!/usr/bin/env node
// Deterministic MSP process fixture. No model credentials or network.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const fingerprint =
  "sha256:03312c213efd14277a0e0a102f70adeae497a469ca4edf7242f479953ed758b7";
const pressured = new Set();
let session,
  events = [],
  seq = 0,
  active,
  approval,
  question,
  interrupting,
  queued = [];
const timers = new Set();
const later = (fn, ms) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const reply = (req, result) => send({ jsonrpc: "2.0", id: req.id, result });
const error = (req, message, kind = "invalidParams", code = -32602) =>
  send({
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message, data: { kind } },
  });
const save = () => {
  if (process.env.FAKE_MUSE_STORE && session)
    writeFileSync(
      join(process.env.FAKE_MUSE_STORE, session.sessionId + ".json"),
      JSON.stringify({ session, events, seq }),
    );
};
const event = (method, params, emit = true) => {
  seq++;
  const e = {
    method,
    params: {
      sessionId: session.sessionId,
      viewCursor: `v:${session.sessionId}:${seq}`,
      sourceRange: {
        stream: { kind: "session", id: session.sessionId },
        first: { id: randomUUID(), sequence: seq },
        last: { id: randomUUID(), sequence: seq },
      },
      ...params,
    },
  };
  if (method !== "item/delta") events.push(e);
  save();
  if (emit) send({ jsonrpc: "2.0", ...e });
  return e;
};
const model = (id) => ({
  modelId: id,
  displayLabel: id,
  providerId: "fake",
  profileId: null,
  releaseDate: null,
  description: null,
  contextLimit: 10000,
  outputLimit: 1000,
  cost: null,
  isDefault: id === "fake-model",
  isActive: session?.modelId === id,
});
const item = (turnId, kind, text, status = "completed", extra = {}) => ({
  itemId: randomUUID(),
  turnId,
  kind,
  text,
  status,
  revision: 1,
  ...extra,
});
function finish(turnId, terminal = "completed") {
  // Whichever settles the turn first wins; a later finish for a turn that is
  // no longer active (e.g. an interrupt racing a decide) is a no-op.
  if (active !== turnId) return;
  interrupting = undefined;
  event("turn/completed", {
    turnId,
    terminal,
    ...(terminal === "failed"
      ? {
          error: {
            kind: "modelError",
            message: "fixture model failure",
            retryable: false,
          },
        }
      : {}),
  });
  active = undefined;
  session.activeTurnId = null;
  save();
  if (queued.length) {
    const next = queued.shift();
    later(() => run(next), 10);
  }
}
function run(p) {
  const turnId = p.commandId;
  active = turnId;
  session.activeTurnId = turnId;
  event("turn/started", { turnId, commandId: p.commandId });
  const user = item(
    turnId,
    "userMessage",
    p.displayText ?? p.input.map((i) => i.text ?? "[Image]").join(""),
    "completed",
    { commandId: p.commandId },
  );
  event("item/completed", { item: user });
  const text = p.input.map((i) => i.text ?? "").join("");
  if (text.includes("crash")) {
    later(() => process.exit(2), 40);
    return;
  }
  if (text.includes("slow")) return;
  if (text.includes("question")) {
    // Structured question the provider cannot render; it will send
    // userInput/cancel, which this fixture rejects as already settled.
    question = {
      userInputId: randomUUID(),
      itemId: randomUUID(),
      toolCallId: "call-question",
      toolName: "askUser",
      turnId,
      autoResolutionMs: 10,
      questions: [
        {
          id: "q1",
          header: "Pick one",
          question: "Which option?",
          options: [{ label: "A" }, { label: "B" }],
          selection: { mode: "single" },
        },
      ],
    };
    event("userInput/requested", question);
    return;
  }
  if (text.includes("approval")) {
    approval = {
      approvalId: randomUUID(),
      availableChoices: [
        {
          choiceId: "allow-once",
          decision: "approved",
          label: "Allow once",
          scope: "once",
        },
        {
          choiceId: "deny-once",
          decision: "denied",
          label: "Deny",
          scope: "once",
        },
      ],
      currentRequirementId: { approvalId: "stage", sourceIndex: 0 },
      itemId: randomUUID(),
      judgeEscalated: false,
      protectedWrite: false,
      rawArgs: "{}",
      subject: { kind: "shell", command: "printf safe" },
      taskId: randomUUID(),
      toolCallId: "call1",
      toolName: "shell",
      turnId,
    };
    if (text.includes("request-only")) {
      const e = event("approval/requested", approval, false);
      send({
        jsonrpc: "2.0",
        id: 10001,
        method: "approval/request",
        params: e.params,
      });
    } else event("approval/requested", approval);
    return;
  }
  if (text.includes("retract")) {
    // Interrupt-paired retract accepted before any assistant output: no
    // turn/completed ever follows (INV-006), only turn/retracted.
    later(() => {
      event("turn/retracted", { turnId, commandId: p.commandId });
      event("item/updated", {
        item: { ...user, retracted: true, revision: 2 },
      });
      active = undefined;
      session.activeTurnId = null;
      save();
    }, 20);
    return;
  }
  const a = item(turnId, "agentMessage", "", "inProgress");
  event("item/started", { item: a });
  if (text.includes("gap")) {
    const after = `v:${session.sessionId}:${seq}`;
    event(
      "item/completed",
      {
        item: { ...a, text: "GAP_RECOVERED", status: "completed", revision: 2 },
      },
      false,
    );
    const next = event(
      "turn/completed",
      { turnId, terminal: "completed" },
      false,
    );
    send({
      jsonrpc: "2.0",
      method: "view/gap",
      params: {
        sessionId: session.sessionId,
        after,
        next: next.params.viewCursor,
      },
    });
    send({ jsonrpc: "2.0", ...next });
    active = undefined;
    return;
  }
  event("item/delta", {
    itemId: a.itemId,
    turnId,
    delta: "hello ",
    field: "text",
  });
  later(() => {
    event("item/delta", {
      itemId: a.itemId,
      turnId,
      delta: "world",
      field: "text",
    });
    event("item/completed", {
      item: { ...a, text: "hello world", status: "completed", revision: 2 },
    });
    // Replay of a stale snapshot must not replace the final row.
    event("item/updated", { item: a });
    finish(turnId);
  }, 35);
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line),
    p = req.params ?? {};
  if (!req.method) return;
  if (process.env.FAKE_MUSE_AUDIT)
    writeFileSync(
      process.env.FAKE_MUSE_AUDIT,
      JSON.stringify({
        method: req.method,
        params: p,
        pid: process.pid,
        cwd: process.cwd(),
        envProbe: process.env.MUSE_TEST_ENV,
      }) + "\n",
      { flag: "a" },
    );
  switch (req.method) {
    case "initialize":
      if (!/^[a-z0-9_]+$/.test(p.clientInfo.name)) {
        error(req, "Bad client name");
        return;
      }
      if (process.env.FAKE_MUSE_HANG_INIT) return;
      reply(req, {
        serverInfo: { name: "fake-muse", version: "1.0.2" },
        schema: {
          version: 1,
          fingerprint: process.env.FAKE_MUSE_FINGERPRINT ?? fingerprint,
        },
        grantedCapabilities: [],
        experimentalApi: false,
        museHome: "/fake",
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "fake",
        sessionDurability: process.argv.includes("--no-session-log")
          ? "ephemeral"
          : "durable",
      });
      return;
    case "initialized":
      return;
    case "model/list":
      reply(req, {
        models: [model("fake-model"), model("other-model")],
        providerId: "fake",
        profileId: null,
        source: "fakeCatalog",
      });
      return;
    case "session/start":
      session = {
        sessionId: randomUUID(),
        workspaceRoot: p.workspaceRoot,
        modelId: p.modelId ?? "fake-model",
        approvalMode: {
          mode: p.approvalMode ?? "promptUnmatched",
          source: "startup",
          lastCommandId: null,
        },
        activeTurnId: null,
        status: "idle",
        path: "/fake/log",
        providerId: "fake",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turnCount: 0,
        forkedFrom: null,
      };
      event(
        "session/modelChanged",
        { modelId: session.modelId, source: "default" },
        false,
      );
      reply(req, { session, viewCursor: events.at(-1).params.viewCursor });
      return;
    case "session/resume": {
      const stored = JSON.parse(
        readFileSync(
          join(process.env.FAKE_MUSE_STORE, p.sessionId + ".json"),
          "utf8",
        ),
      );
      ({ session, events, seq } = stored);
      reply(req, {
        session,
        viewCursor: events.at(-1).params.viewCursor,
        history: { mode: "none", items: null, snapshot: null },
        pendingRequests: [],
      });
      return;
    }
    case "session/read":
      reply(req, {
        session,
        viewCursor: events.at(-1)?.params.viewCursor ?? "empty",
        history: { mode: "none", items: null, snapshot: null },
        pendingRequests: [],
      });
      return;
    case "view/page": {
      const start = p.cursor
        ? events.findIndex((e) => e.params.viewCursor === p.cursor) + 1
        : 0;
      const page = events.slice(start, start + Math.min(p.limit, 3));
      reply(req, {
        events: page,
        nextCursor:
          start + page.length < events.length
            ? page.at(-1).params.viewCursor
            : null,
      });
      return;
    }
    case "turn/start": {
      if (
        p.input.some((i) => i.text === "pressure") &&
        !pressured.has(p.commandId)
      ) {
        pressured.add(p.commandId);
        error(req, "Busy", "backpressured", -32031);
        return;
      }
      if (p.input.some((i) => i.text === "reject")) {
        error(req, "Prompt rejected", "commandRejected", -32000);
        return;
      }
      if (p.input.some((i) => i.text === "launch-failure")) {
        reply(req, {
          commandId: p.commandId,
          status: "accepted",
          turnId: p.commandId,
          disposition: "queued",
          startedNewTurn: false,
        });
        event("turn/completed", {
          turnId: p.commandId,
          terminal: "failed",
          error: {
            kind: "launchError",
            message: "launch failed",
            retryable: false,
          },
        });
        return;
      }
      const busy = !!active;
      // Deliberately emit before the acknowledgement in the immediate case.
      if (!busy) run(p);
      else queued.push(p);
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        turnId: p.commandId,
        disposition: busy ? "queued" : "started",
        startedNewTurn: !busy,
      });
      return;
    }
    case "turn/steer":
      if (p.expectedTurnId !== active) {
        error(req, "Wrong turn", "commandRejected", -32000);
        return;
      }
      event("item/completed", {
        item: item(
          active,
          "userMessage",
          p.input.map((i) => i.text ?? "").join(""),
          "completed",
          { commandId: p.commandId, steered: true },
        ),
      });
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        turnId: active,
      });
      return;
    case "turn/interrupt":
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        turnId: active,
      });
      // An accepted interrupt is authoritative: a decide whose delayed
      // completion is still pending must not finish the turn "completed".
      interrupting = active;
      later(() => {
        if (active) finish(active, "cancelled");
      }, 40);
      return;
    case "turn/unqueue": {
      const index = queued.findIndex((q) => q.commandId === p.turnId);
      if (index < 0) {
        error(req, "Not queued");
        return;
      }
      const [q] = queued.splice(index, 1);
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        turnId: p.turnId,
      });
      event("turn/unqueued", { turnId: p.turnId, commandId: q.commandId });
      return;
    }
    case "approval/decide": {
      if (
        !approval ||
        p.approvalId !== approval.approvalId ||
        p.requirementId.sourceIndex !==
          approval.currentRequirementId.sourceIndex ||
        !approval.availableChoices.some((c) => c.choiceId === p.choiceId)
      ) {
        error(req, "Invalid approval choice", "approvalChoiceInvalid", -32052);
        return;
      }
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        approvalId: p.approvalId,
        terminal: true,
      });
      later(() => {
        event("approval/resolved", {
          approvalId: p.approvalId,
          itemId: approval.itemId,
          turnId: approval.turnId,
          decision: p.choiceId === "deny-once" ? "denied" : "approved",
          policyResult: p.choiceId === "deny-once" ? "deny" : "allow",
          resolvedBy: "user",
          stageEvidence: [],
        });
        if (interrupting !== approval.turnId) finish(approval.turnId);
        approval = undefined;
      }, 40);
      return;
    }
    case "userInput/cancel": {
      // Race: the question settled (timed out) before the cancel arrived.
      error(req, "Already settled", "userInputAlreadySettled", -32062);
      if (question && p.userInputId === question.userInputId) {
        const q = question;
        question = undefined;
        event("userInput/settled", {
          userInputId: q.userInputId,
          outcome: "timedOut",
          answers: [],
          clarification: null,
          decidedByCommandId: null,
          reason: "auto-resolved by fixture",
        });
        finish(q.turnId);
      }
      return;
    }
    case "session/setModel":
      session.modelId = p.model.modelId;
      event("session/modelChanged", {
        modelId: session.modelId,
        source: "user",
      });
      reply(req, { commandId: p.commandId, status: "accepted" });
      return;
    case "session/setApprovalMode":
      session.approvalMode = {
        mode: p.mode,
        source: "approvalReconfigure",
        lastCommandId: p.commandId,
      };
      event("session/approvalModeChanged", {
        mode: p.mode,
        source: "approvalReconfigure",
        commandId: p.commandId,
        clientName: "paseo_muse",
      });
      reply(req, {
        commandId: p.commandId,
        status: "accepted",
        effectiveMode: session.approvalMode,
        applyOutcome: "completed",
      });
      return;
    default:
      error(req, "Unsupported " + req.method);
  }
});
rl.on("close", () => {
  for (const timer of timers) clearTimeout(timer);
  save();
  process.exit(0);
});
