import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWindowsHandoff } from "../scripts/build-windows-handoff.mjs";

test("Windows handoff is dry-run by default and publishes a checksummed source snapshot head-last", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "session-harbor-handoff-"));
  const options = {
    outputRoot,
    handoffId: "synthetic-handoff-v0.3.1",
    createdAt: "2026-08-26T00:00:00.000Z",
    producerDeviceId: "mac-synthetic-producer",
    producerEvidence: "../../results/mac-synthetic-producer-result.json",
  };
  const planned = await buildWindowsHandoff(options);
  assert.equal(planned.apply, false);
  assert.ok(planned.sourceFileCount > 0);

  const appleDoublePath = path.join(outputRoot, "._stale-handoff-metadata");
  await writeFile(appleDoublePath, "synthetic AppleDouble metadata");
  const applied = await buildWindowsHandoff({ ...options, apply: true });
  assert.equal(applied.apply, true);
  await assert.rejects(() => stat(appleDoublePath), { code: "ENOENT" });
  const latest = JSON.parse(await readFile(path.join(outputRoot, "LATEST.json"), "utf8"));
  const startHere = await readFile(path.join(outputRoot, "START_HERE.txt"), "utf8");
  assert.equal(latest.handoffId, options.handoffId);
  assert.match(startHere, /Read LATEST\.json/);
  const releaseRoot = path.join(outputRoot, ...latest.releasePath.split("/"));
  const handoff = JSON.parse(await readFile(path.join(releaseRoot, "handoff.json"), "utf8"));
  const checksums = await readFile(path.join(releaseRoot, "SHA256SUMS"), "utf8");
  const windowsPrompt = await readFile(
    path.join(releaseRoot, "WINDOWS_CODEX_PROMPT.zh-CN.txt"),
    "utf8",
  );
  assert.equal(handoff.status, "ready-for-windows");
  assert.equal(handoff.project.license, "PolyForm-Noncommercial-1.0.0");
  assert.equal(
    handoff.producerEvidence,
    options.producerEvidence,
  );
  assert.equal(handoff.ownership.producerDeviceId, options.producerDeviceId);
  assert.match(windowsPrompt, new RegExp(options.handoffId));
  assert.match(windowsPrompt, /devices\/mac-synthetic-producer/);
  assert.match(checksums, /source\/plugins\/session-harbor\/\.codex-plugin\/plugin\.json/);
  for (const requiredPath of [
    "AGENTS.md",
    "evals/plugin-discovery.json",
    "PRIVACY.md",
    "SUPPORT.md",
    "TERMS.md",
  ]) {
    assert.match(checksums, new RegExp(`source/${requiredPath.replaceAll(".", "\\.")}`));
  }
  assert.match(checksums, /WINDOWS_HANDOFF\.md/);
  assert.match(checksums, /WINDOWS_CODEX_PROMPT\.zh-CN\.txt/);
  assert.doesNotMatch(checksums, /source\/\.git\//);
  assert.doesNotMatch(checksums, /node_modules/);
});
