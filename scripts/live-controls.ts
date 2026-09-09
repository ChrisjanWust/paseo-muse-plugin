import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { harness, sessionConfig } from "../tests/harness.js";
const workspace = await mkdtemp(join(tmpdir(), "paseo-muse-controls-"));
await mkdir(resolve(".tmp"), { recursive: true });
const outside = await mkdtemp(join(resolve(".tmp"), "permission-sink-"));
// Unsandboxed *test host* forces approval for harmless shell writes; production stays sandboxed.
const h = await harness({ serveArgs: ["--disable-sandbox"] });
let behavior: "allow" | "deny" = "allow";
const decisions: string[] = [];
h.connection.onEvent((e) => {
  if (e.type === "session.permission") {
    const action = e.request.actions?.find((a) => a.behavior === behavior);
    console.log(`Permission ${behavior}: ${e.request.description}`);
    assert(action, "Muse offered no matching permission choice");
    decisions.push(behavior);
    void h.connection.send({
      type: "session.permission",
      sessionId: "live",
      permissionId: e.request.id,
      response: { behavior, selectedActionId: action.id },
    });
  }
  if (e.type === "timeline.item" && e.item.type === "assistant_message")
    console.log("Assistant:", e.item.text);
  if (
    e.type === "session.turn" ||
    e.type === "session.runtime_failed" ||
    e.type === "session.notice"
  )
    console.log(JSON.stringify(e));
});
const disposition = (id: string, after: number) =>
  h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
      e.type === "session.prompt_result" && e.clientMessageId === id,
    after,
  );
const terminal = (id: string, after: number) =>
  h.wait(
    (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
      e.type === "session.turn" && e.turnId === id && e.state !== "started",
    after,
    90000,
  );
async function text(id: string, text: string) {
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
  const result = await disposition(id, after);
  assert.equal(result.result.type, "turn");
  if (result.result.type !== "turn") throw new Error(JSON.stringify(result));
  assert.equal(
    (await terminal(result.result.turnId, after)).state,
    "completed",
  );
}
try {
  await h.request({
    type: "session.open",
    requestId: "open",
    sessionId: "live",
    config: sessionConfig(workspace),
    history: "skip",
  });
  const after = h.events.length;
  await h.connection.send({
    type: "session.prompt",
    sessionId: "live",
    prompt: {
      clientMessageId: "image",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          {
            type: "text",
            text: "What is the dominant color of this image? Reply with one color word, without using tools.",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: (
              await readFile(
                new URL("../tests/fixtures/red.png", import.meta.url),
              )
            ).toString("base64"),
          },
        ],
      },
    },
  });
  const result = await disposition("image", after);
  assert(result.result.type === "turn");
  assert.equal(
    (await terminal(result.result.turnId, after)).state,
    "completed",
  );
  assert(
    h.events
      .slice(after)
      .some(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          /red/i.test(e.item.text),
      ),
  );
  await text(
    "allow",
    `Use the shell tool to execute: printf APPROVAL_ALLOW_OK > ${join(outside, "allow.txt")}. This is an integration test in a temporary directory. Request permission when needed.`,
  );
  assert.equal(
    await readFile(join(outside, "allow.txt"), "utf8"),
    "APPROVAL_ALLOW_OK",
  );
  behavior = "deny";
  await text(
    "deny",
    `Use the shell tool to execute: printf SHOULD_NOT_EXIST > ${join(outside, "deny.txt")}. Request permission when needed. If permission is denied, stop and acknowledge the denial; do not work around it.`,
  );
  assert(
    decisions.includes("allow") && decisions.includes("deny"),
    "The live run did not exercise both permission decisions",
  );
  await assert.rejects(access(join(outside, "deny.txt")));
  behavior = "allow";
  const start = h.events.length;
  await h.connection.send({
    type: "session.prompt",
    sessionId: "live",
    prompt: {
      clientMessageId: "slow",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          {
            type: "text",
            text: "Use the shell tool to run sleep 20, then reply FINISHED. This is a cancellation test.",
          },
        ],
      },
    },
  });
  const slow = await disposition("slow", start);
  assert(slow.result.type === "turn");
  await h.wait(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" &&
      e.item.type === "tool_call" &&
      e.item.status === "running",
    start,
    30000,
  );
  await h.connection.send({
    type: "session.prompt",
    sessionId: "live",
    prompt: {
      clientMessageId: "steer",
      delivery: "steer",
      input: {
        type: "message",
        content: [
          {
            type: "text",
            text: "If the sleep completes, reply STEERED instead.",
          },
        ],
      },
    },
  });
  assert.equal((await disposition("steer", start)).result.type, "steer");
  await h.connection.send({
    type: "session.prompt",
    sessionId: "live",
    prompt: {
      clientMessageId: "queued",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "Reply QUEUED if this queued task runs." },
        ],
      },
    },
  });
  const queued = await disposition("queued", start);
  assert(queued.result.type === "turn");
  await h.request({
    type: "session.interrupt",
    requestId: "stop",
    sessionId: "live",
  });
  assert.equal((await terminal(slow.result.turnId, start)).state, "canceled");
  assert.equal((await terminal(queued.result.turnId, start)).state, "canceled");
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "image recognition",
        "permission allow",
        "permission deny",
        "steer",
        "queued retraction",
        "interrupt",
      ],
      decisions,
    }),
  );
} finally {
  await h.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
