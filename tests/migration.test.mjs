import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hashFile,
  initializeStorage,
  normalizeConfig,
  pathExists,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import { migrateLayout } from "../plugins/session-harbor/scripts/lib/migration.mjs";
import { readSessionHead } from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";

const SESSION_A = "019f6000-1111-7111-8111-111111111111";
const SESSION_B = "019f6000-2222-7222-8222-222222222222";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-m5-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  const initialized = await initializeStorage(
    configPath,
    normalizeConfig({
      codexHome,
      destination,
      device: { id: "mac-migration", displayName: "Migration Mac", platform: "macos" },
    }),
    { apply: true },
  );
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-21T00:00:00Z",
    runRecordId: "019f6000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { base, codexHome, destination, configPath, config };
}

test("CodexBridge migration plans and imports payloads without modifying legacy bytes", async () => {
  const item = await fixture();
  const legacy = path.join(item.base, "CodexBridge");
  const payload = path.join(legacy, "devices", "old-mac", "backups", "run-one", "payload", "sessions");
  await mkdir(payload, { recursive: true });
  const sourceA = path.join(payload, `rollout-2026-08-01-${SESSION_A}.jsonl`);
  const sourceB = path.join(payload, `rollout-2026-08-02-${SESSION_B}.jsonl`);
  const duplicate = path.join(payload, "copy", `rollout-2026-08-01-${SESSION_A}.jsonl`);
  await mkdir(path.dirname(duplicate), { recursive: true });
  await writeFile(sourceA, sessionContent(SESSION_A, "legacy A"));
  await writeFile(sourceB, sessionContent(SESSION_B, "legacy B"));
  await writeFile(duplicate, await readFile(sourceA));
  const old = new Date("2026-08-01T00:00:00Z");
  await utimes(sourceA, old, old);
  await utimes(sourceB, old, old);
  await utimes(duplicate, old, old);
  const before = await Promise.all([hashFile(sourceA), hashFile(sourceB), hashFile(duplicate)]);

  const plan = await migrateLayout(item.config, legacy, "codexbridge");
  assert.equal(plan.apply, false);
  assert.equal(plan.counts.discovered, 3);
  assert.equal(plan.counts.importable, 2);
  assert.equal(plan.counts.duplicates, 1);
  assert.equal((await readSessionHead(item.config)), null);

  const applied = await migrateLayout(item.config, legacy, "codexbridge", {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f6000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(applied.publication.counts.objectsPublished, 2);
  const current = await readSessionHead(item.config, item.config.device.id, { verifyObjects: true });
  assert.equal(current.manifest.objects.length, 2);
  assert.equal(
    current.manifest.objects.every((object) => object.sourceKey.startsWith("archived_sessions/imported/codexbridge/")),
    true,
  );
  assert.equal(JSON.stringify(current.manifest).includes(item.base), false);
  assert.deepEqual(await Promise.all([hashFile(sourceA), hashFile(sourceB), hashFile(duplicate)]), before);

  const repeated = await migrateLayout(item.config, legacy, "codexbridge", {
    apply: true,
    now: "2026-08-22T01:00:00Z",
    runId: "019f6000-cccc-7ccc-8ccc-cccccccccccc",
  });
  assert.equal(repeated.publication.counts.objectsPublished, 0);
  assert.equal(repeated.publication.counts.snapshotsPublished, 0);
});

test("v0.1 catalog migration verifies targets and preserves the old catalog", async () => {
  const item = await fixture();
  const legacy = path.join(item.base, "v01");
  const targetRelativePath = `files/sessions/rollout-2026-08-01-${SESSION_A}.jsonl`;
  const target = path.join(legacy, ...targetRelativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, sessionContent(SESSION_A, "v01"));
  const digest = await hashFile(target);
  const catalog = {
    version: 1,
    updatedAt: "2026-08-20T00:00:00Z",
    entries: [
      {
        id: "legacy-entry-one",
        sessionId: SESSION_A,
        targetRelativePath,
        sizeBytes: Number((await stat(target)).size),
        sha256: digest,
      },
    ],
  };
  const catalogPath = path.join(legacy, "catalog-v1.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const beforeCatalog = await readFile(catalogPath, "utf8");

  const applied = await migrateLayout(item.config, legacy, "v01", {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f6001-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(applied.counts.importable, 1);
  assert.equal((await readSessionHead(item.config)).manifest.objects[0].sha256, digest);
  assert.equal(await readFile(catalogPath, "utf8"), beforeCatalog);
  assert.equal(await readFile(target, "utf8"), sessionContent(SESSION_A, "v01"));
});

test("tampered v0.1 target blocks apply and creates no session head", async () => {
  const item = await fixture();
  const legacy = path.join(item.base, "v01-bad");
  const targetRelativePath = `files/sessions/rollout-2026-08-01-${SESSION_A}.jsonl`;
  const target = path.join(legacy, ...targetRelativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "tampered");
  await writeFile(
    path.join(legacy, "catalog-v1.json"),
    `${JSON.stringify({
      version: 1,
      entries: [
        {
          id: "legacy-entry-bad",
          sessionId: SESSION_A,
          targetRelativePath,
          sizeBytes: 8,
          sha256: "a".repeat(64),
        },
      ],
    })}\n`,
  );
  const plan = await migrateLayout(item.config, legacy, "v01");
  assert.equal(plan.ok, false);
  assert.equal(plan.counts.failed, 1);
  await assert.rejects(
    () => migrateLayout(item.config, legacy, "v01", { apply: true }),
    (error) => error.code === "MIGRATION_INVENTORY_INCOMPLETE",
  );
  assert.equal((await readSessionHead(item.config)), null);
});

function sessionContent(sessionId, message) {
  return `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } })}\n`;
}
