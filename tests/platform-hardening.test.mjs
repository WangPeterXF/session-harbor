import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { initializeStorage, normalizeConfig } from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import { pushSessionSnapshot, readSessionHead } from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";

const SESSION_ID = "019f7000-1111-7111-8111-111111111111";
const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Node entrypoints execute when invoked through native Windows paths", async () => {
  const cliPath = path.join(
    REPOSITORY_ROOT,
    "plugins",
    "session-harbor",
    "scripts",
    "session-harbor.mjs",
  );
  const taskPath = path.join(
    REPOSITORY_ROOT,
    "plugins",
    "session-harbor",
    "scripts",
    "windows-task.mjs",
  );
  const cli = await execFileAsync(process.execPath, [cliPath, "version"]);
  assert.match(cli.stdout, /^session-harbor 0\.3\.0/m);
  const task = await execFileAsync(process.execPath, [taskPath, "help"]);
  assert.match(task.stdout, /node windows-task\.mjs render/);
});

test("scheduled backup exits successfully when its destination is unavailable", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-missing-drive-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "detached-drive", "SessionHarbor");
  const configPath = path.join(base, "config with spaces.json");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(normalizeConfig({ codexHome, destination }), null, 2)}\n`,
  );
  const cliPath = path.join(
    REPOSITORY_ROOT,
    "plugins",
    "session-harbor",
    "scripts",
    "session-harbor.mjs",
  );
  const result = await execFileAsync(process.execPath, [
    cliPath,
    "backup",
    "run",
    "--apply",
    "--if-available",
    "--config",
    configPath,
    "--json",
  ]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, "backup-skipped");
  assert.equal(parsed.reason, "destination-unavailable");
  assert.equal(parsed.destination, destination);
});

test("Windows project paths remain private and normalize without leaking into contracts", () => {
  const config = normalizeConfig({
    device: { id: "windows-long", displayName: "Windows", platform: "windows" },
    projects: {
      "unicode-project": "C:\\Users\\Example User\\项目\\Very Long Project Name",
    },
  });
  assert.equal(
    config.projects["unicode-project"],
    "C:\\Users\\Example User\\项目\\Very Long Project Name",
  );
});

test("client-synchronized folders cannot enable link or delete reclamation", () => {
  assert.throws(
    () =>
      normalizeConfig({
        exchange: { adapter: "filesystem", storageClass: "client-synced", autoPublish: true },
        retention: {
          archiveAfterDays: 30,
          localGraceDays: 7,
          reclaimAction: "delete",
          autoReclaim: true,
        },
      }),
    (error) => error.code === "CONFIG_SYNCED_RECLAIM_UNSAFE",
  );
  const safe = normalizeConfig({
    exchange: { adapter: "filesystem", storageClass: "client-synced", autoPublish: true },
    retention: {
      archiveAfterDays: 30,
      localGraceDays: 7,
      reclaimAction: "keep",
      autoReclaim: false,
    },
  });
  assert.equal(safe.mode, "copy-only");
});

test("long Unicode session paths publish with portable slash-separated metadata", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-unicode-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "外置硬盘", "SessionHarbor");
  const configPath = path.join(base, "配置", "config.json");
  const deep = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    "很长的目录名称".repeat(8),
  );
  await mkdir(deep, { recursive: true });
  const source = path.join(deep, `rollout-2026-08-20T00-00-00-${SESSION_ID}.jsonl`);
  await writeFile(source, `${JSON.stringify({ type: "session_meta", payload: { id: SESSION_ID } })}\n`);
  await utimes(source, new Date("2026-08-20T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
  const initialized = await initializeStorage(
    configPath,
    normalizeConfig({
      codexHome,
      destination,
      roots: ["sessions", "archived_sessions"],
      minimumSizeMB: 0,
      device: { id: "mac-unicode", displayName: "Unicode Mac", platform: "macos" },
    }),
    { apply: true },
  );
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    runRecordId: "019f7000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  await pushSessionSnapshot(config, {
    apply: true,
    runId: "019f7000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  const head = await readSessionHead(config, config.device.id, { verifyObjects: true });
  assert.equal(head.manifest.objects.length, 1);
  assert.equal(head.manifest.objects[0].sourceKey.includes("\\"), false);
  assert.equal(head.manifest.objects[0].sourceKey.includes(base), false);
  assert.match(head.manifest.objects[0].objectPath, /^devices\/mac-unicode\//);
});
