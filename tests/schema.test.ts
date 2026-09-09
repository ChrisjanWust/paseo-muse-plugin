import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Session, EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { toMuseInput, projectItem } from "../server/mapping.js";
test("pinned SDK fingerprint and actual host-generated image schema", async () => {
  const fixture = (name: string) =>
    readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(
      JSON.parse,
    );
  assert.equal(
    (await fixture("compatibility.json")).fingerprint,
    EXPECTED_SCHEMA_FINGERPRINT,
  );
  const validate = new Ajv2020()
    .addKeyword("x-msp-openness")
    .compile(await fixture("turn-input.schema.json"));
  const png = await readFile(new URL("./fixtures/red.png", import.meta.url));
  const input = toMuseInput([
    { type: "text", text: "color?" },
    { type: "image", mimeType: "image/png", data: png.toString("base64") },
  ]);
  for (const part of input)
    assert(validate(part), JSON.stringify(validate.errors));
  assert(!validate({ type: "file", path: "/arbitrary" }));
});
test("captured real Muse transcript folds to the completed assistant response", async () => {
  const events = JSON.parse(
    await readFile(
      new URL("./fixtures/live-text.json", import.meta.url),
      "utf8",
    ),
  );
  const session = new Session({
    sessionId: events[0].params.sessionId,
    durability: { kind: "durable" },
  });
  for (const event of events) session.apply(event);
  const projected = session.fold.items
    .list()
    .map((item) => projectItem(item, session.fold, session.sessionId));
  assert(
    projected.some(
      (i) => i.type === "assistant_message" && i.text === "MUSE_PASEO_OK",
    ),
  );
  assert(session.fold.turns().every((t) => t.terminal === "completed"));
});
