import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
const pinned = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/compatibility.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(EXPECTED_SCHEMA_FINGERPRINT, pinned.fingerprint);
const directory = await mkdtemp(join(tmpdir(), "paseo-muse-schema-"));
try {
  await promisify(execFile)(process.env.MUSE_BIN ?? "muse", [
    "schema",
    "generate-json-schema",
    "--out",
    directory,
  ]);
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.fingerprint,
    pinned.fingerprint,
    "MSP changed: review the exported schema and update the adapter/tests before repinning",
  );
  console.log(`Muse schema matches ${pinned.fingerprint}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
