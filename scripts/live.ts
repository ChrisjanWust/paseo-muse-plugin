import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { harness, sessionConfig } from "../tests/harness.js";
const workspace = await mkdtemp(join(tmpdir(), "paseo-muse-live-"));
const h = await harness();
let permissions = 0;
h.connection.onEvent((e) => {
  if (e.type === "session.permission") {
    permissions++;
    const action = e.request.actions?.find((a) => a.behavior === "allow");
    if (action)
      void h.connection.send({
        type: "session.permission",
        sessionId: e.sessionId,
        permissionId: e.request.id,
        response: { behavior: "allow", selectedActionId: action.id },
      });
  }
  if (
    ["session.turn", "session.runtime_failed", "session.notice"].includes(
      e.type,
    )
  )
    console.log(JSON.stringify(e));
});
async function prompt(id: string, text: string) {
  const after = h.events.length;
  await h.connection.send({
    type: "session.prompt",
    sessionId: "live",
    prompt: {
      clientMessageId: id,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });
  const result = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
      e.type === "session.prompt_result" && e.clientMessageId === id,
    after,
  );
  assert.equal(result.result.type, "turn");
  if (result.result.type !== "turn") throw new Error("No turn");
  const turnId = result.result.turnId;
  const terminal = await h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" && e.turnId === turnId && e.state !== "started",
    after,
    90000,
  );
  assert.equal(terminal.state, "completed", JSON.stringify(terminal));
  return h.events.slice(after);
}
try {
  const catalog = await h.request({
    type: "catalog",
    requestId: "catalog",
    cwd: workspace,
  });
  assert(catalog.type === "catalog" && catalog.catalog.models.length > 0);
  await h.request({
    type: "session.open",
    requestId: "open",
    sessionId: "live",
    history: "skip",
    config: sessionConfig(workspace),
  });
  const opening = h.events.find(
    (e): e is Extract<ProviderEvent, { type: "session.opened" }> =>
      e.type === "session.opened",
  );
  assert(opening?.persistence);
  const text = await prompt(
    "text",
    "Reply with exactly MUSE_PASEO_OK. Do not use tools.",
  );
  assert(
    text.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text.includes("MUSE_PASEO_OK"),
    ),
  );
  await prompt(
    "tool",
    "Use your shell tool to run python3 -c \"from pathlib import Path; Path('smoke.txt').write_text('MUSE_TOOL_OK')\" in the current workspace. Then read smoke.txt and report its contents.",
  );
  assert.equal(
    await readFile(join(workspace, "smoke.txt"), "utf8"),
    "MUSE_TOOL_OK",
  );
  assert(
    h.events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "tool_call" &&
        e.item.status === "completed",
    ),
  );
  await h.request({
    type: "session.configure",
    requestId: "mode",
    sessionId: "live",
    changes: { mode: "denyUnmatched", thinkingOption: "medium" },
  });
  await h.request({
    type: "session.close",
    requestId: "close",
    sessionId: "live",
  });
  const after = h.events.length;
  await h.request({
    type: "session.open",
    requestId: "resume",
    sessionId: "live",
    history: "replay",
    config: { ...sessionConfig(workspace), mode: "denyUnmatched" },
    persistence: opening.persistence,
  });
  assert(
    h.events
      .slice(after)
      .some(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text.includes("MUSE_PASEO_OK"),
      ),
  );
  await prompt(
    "resumed",
    "What exact string did you write into smoke.txt earlier? Answer from the conversation without tools.",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "catalog",
        "text",
        "tool execution",
        "mode/thinking change",
        "durable resume",
        "history replay",
        "continued conversation",
      ],
      permissionsObserved: permissions,
    }),
  );
} finally {
  await h.close();
  await rm(workspace, { recursive: true, force: true });
}
