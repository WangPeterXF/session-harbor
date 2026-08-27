import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ColdStorageError,
  initializeStorage,
  loadConfig,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { validateContract } from "../plugins/session-harbor/scripts/lib/bridge-contracts.mjs";
import {
  bridgeDoctor,
  deviceManifestPath,
  initializeDevice,
  showDevice,
} from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import { main } from "../plugins/session-harbor/scripts/session-harbor.mjs";

const NOW = "2026-08-26T02:00:00Z";
const RUN_ONE = "019f0000-6000-7777-8888-9999aaaabbbb";
const RUN_TWO = "019f0000-7000-7888-8999-aaaabbbbcccc";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-device-test-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  await mkdir(codexHome, { recursive: true });
  const initialized = await initializeStorage(
    configPath,
    {
      codexHome,
      destination,
      strictOpenFileCheck: false,
    },
    { apply: true },
  );
  return { base, codexHome, destination, configPath, config: initialized.config };
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      log: (...items) => stdout.push(items.join(" ")),
      error: (...items) => stderr.push(items.join(" ")),
    },
    stdout,
    stderr,
  };
}

test("version and --version both return the CLI version", async () => {
  for (const args of [["version"], ["--version"]]) {
    const output = captureIo();
    assert.equal(await main(args, output.io), 0);
    assert.deepEqual(output.stdout, ["session-harbor 0.3.1"]);
  }
});

test("CLI persists the two retention clocks and explicit reclaim action", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-cli-retention-"));
  const configPath = path.join(base, "config.json");
  const destination = path.join(base, "vault");
  const output = captureIo();
  const code = await main(
    [
      "init",
      "--destination",
      destination,
      "--cleanup-after-inactive-days",
      "45",
      "--minimum-backup-age-days",
      "14",
      "--reclaim-action",
      "delete",
      "--auto-reclaim",
      "--apply",
      "--config",
      configPath,
      "--json",
    ],
    output.io,
  );
  assert.equal(code, 0);
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(stored.retention, {
    cleanupAfterInactiveDays: 45,
    minimumBackupAgeDays: 14,
    reclaimAction: "delete",
    autoReclaim: true,
  });
  assert.deepEqual(stored.backup, {
    scope: "all",
    allowPartial: true,
    verifyExistingObjects: false,
  });
  assert.equal(Object.hasOwn(stored, "olderThanDays"), false);
  assert.equal(Object.hasOwn(stored, "graceDays"), false);
  assert.equal(Object.hasOwn(stored, "mode"), false);
});

test("config v1 upgrades in memory without rewriting the file", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-config-v1-test-"));
  const configPath = path.join(base, "config.json");
  const original = {
    version: 1,
    codexHome: path.join(base, ".codex"),
    destination: path.join(base, "vault"),
    destinationId: "",
    roots: ["sessions"],
    olderThanDays: 10,
    minimumSizeMB: 1,
    graceDays: 2,
    mode: "copy-only",
    compression: "none",
    compressionLevel: 19,
    strictOpenFileCheck: false,
  };
  await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.version, 4);
  assert.equal(loaded.device.id, "");
  assert.equal(loaded.exchange.adapter, "filesystem");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).version, 1);
});

test("applied destination init persists config v4 while preserving v1 cleanup settings", async () => {
  const item = await fixture();
  const current = JSON.parse(await readFile(item.configPath, "utf8"));
  const legacy = {
    version: 1,
    codexHome: current.codexHome,
    destination: current.destination,
    destinationId: current.destinationId,
    roots: ["sessions"],
    olderThanDays: 17,
    minimumSizeMB: 3,
    graceDays: 4,
    mode: "copy-only",
    compression: "none",
    compressionLevel: 18,
    strictOpenFileCheck: false,
  };
  await writeFile(item.configPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const output = captureIo();
  assert.equal(
    await main(
      ["init", "--destination", item.destination, "--config", item.configPath, "--apply", "--json"],
      output.io,
    ),
    0,
  );
  const persisted = JSON.parse(await readFile(item.configPath, "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.retention.cleanupAfterInactiveDays, 17);
  assert.equal(persisted.retention.minimumBackupAgeDays, 4);
  assert.equal(persisted.retention.reclaimAction, "keep");
  assert.equal(persisted.compressionLevel, 18);
  assert.deepEqual(persisted.roots, ["sessions"]);
  assert.equal(persisted.device.id, "");
});

test("device init dry-run creates no protocol, identity, manifest, or run record", async () => {
  const item = await fixture();
  const result = await initializeDevice(item.configPath, item.config, { apply: false, now: NOW });
  assert.equal(result.apply, false);
  assert.equal(result.willGenerateDeviceId, true);
  assert.equal(result.plan.protocol, "create");
  await assert.rejects(() => stat(path.join(item.destination, "protocol.json")), { code: "ENOENT" });
  await assert.rejects(() => stat(path.join(item.destination, "devices")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(item.configPath, "utf8")).device.id, "");
});

test("bridge doctor reports an uninitialized vault without writing it", async () => {
  const item = await fixture();
  const diagnosis = await bridgeDoctor(item.config);
  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.checks.some((check) => check.code === "BRIDGE_FILE_MISSING"), true);
  assert.equal(diagnosis.checks.some((check) => check.code === "DEVICE_NOT_INITIALIZED"), true);
  await assert.rejects(() => stat(path.join(item.destination, "protocol.json")), { code: "ENOENT" });
});

test("an uninitialized config honors an explicit Windows identity", async () => {
  const item = await fixture();
  const result = await initializeDevice(item.configPath, item.config, {
    apply: false,
    deviceId: "windows-test-one",
    displayName: "Test Windows PC",
    platform: "windows",
    now: NOW,
  });
  assert.equal(result.device.id, "windows-test-one");
  assert.equal(result.device.platform, "windows");
  assert.equal(result.protocol.kind, "vault-protocol");
});

test("applied device init publishes valid protocol, device manifest, and run record", async () => {
  const item = await fixture();
  const liveSession = path.join(
    item.codexHome,
    "sessions",
    "2026",
    "08",
    "26",
    "rollout-2026-08-26T02-00-00-019f0000-9999-7aaa-8bbb-ccccddddeeee.jsonl",
  );
  await mkdir(path.dirname(liveSession), { recursive: true });
  await writeFile(liveSession, '{"type":"session_meta","payload":{"id":"synthetic"}}\n');
  const result = await initializeDevice(item.configPath, item.config, {
    apply: true,
    deviceId: "mac-test-one",
    displayName: "Test Mac",
    platform: "macos",
    now: NOW,
    runRecordId: RUN_ONE,
  });
  assert.equal(result.created.protocol, true);
  assert.equal(result.created.manifest, true);
  assert.equal(result.created.runRecord, true);

  const protocol = JSON.parse(await readFile(path.join(item.destination, "protocol.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(path.join(item.destination, ...deviceManifestPath("mac-test-one").split("/")), "utf8"),
  );
  const run = JSON.parse(
    await readFile(
      path.join(item.destination, "devices", "mac-test-one", "runs", "2026", "08", `${RUN_ONE}.json`),
      "utf8",
    ),
  );
  assert.equal(validateContract(protocol).kind, "vault-protocol");
  assert.equal(validateContract(manifest).kind, "device-manifest");
  assert.equal(validateContract(run).operation, "device-init");
  assert.equal(run.counts.protocolCreated, 1);
  assert.equal(run.counts.deviceManifestCreated, 1);
  assert.equal((await loadConfig(item.configPath)).device.id, "mac-test-one");
  assert.equal(await readFile(liveSession, "utf8"), '{"type":"session_meta","payload":{"id":"synthetic"}}\n');
  await assert.rejects(
    () => stat(path.join(item.destination, "devices", "mac-test-one", "sessions")),
    { code: "ENOENT" },
  );

  const shown = await showDevice(await loadConfig(item.configPath));
  assert.equal(shown.manifest.deviceId, "mac-test-one");
  const diagnosis = await bridgeDoctor(await loadConfig(item.configPath));
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.warnings.some((warning) => warning.code === "FILESYSTEM_DURABILITY_NOT_PROBED"), true);
});

test("repeated device init is idempotent apart from an immutable run record", async () => {
  const item = await fixture();
  const first = await initializeDevice(item.configPath, item.config, {
    apply: true,
    deviceId: "mac-test-two",
    displayName: "Test Mac Two",
    platform: "macos",
    now: NOW,
    runRecordId: RUN_ONE,
  });
  const second = await initializeDevice(item.configPath, await loadConfig(item.configPath), {
    apply: true,
    now: "2026-08-26T02:01:00Z",
    runRecordId: RUN_TWO,
  });
  assert.equal(first.created.protocol, true);
  assert.equal(second.created.protocol, false);
  assert.equal(second.created.manifest, false);
  assert.equal(second.runRecord.counts.configUpdated, 0);
  const runs = await readdir(path.join(item.destination, "devices", "mac-test-two", "runs", "2026", "08"));
  assert.deepEqual(runs.sort(), [`${RUN_ONE}.json`, `${RUN_TWO}.json`]);
});

test("a stored device identity cannot be rebound by flags or a changed manifest", async () => {
  const item = await fixture();
  await initializeDevice(item.configPath, item.config, {
    apply: true,
    deviceId: "mac-stable-one",
    displayName: "Stable Mac",
    platform: "macos",
    now: NOW,
    runRecordId: RUN_ONE,
  });
  const config = await loadConfig(item.configPath);
  await assert.rejects(
    () =>
      initializeDevice(item.configPath, config, {
        apply: true,
        deviceId: "mac-different-one",
        runRecordId: RUN_TWO,
      }),
    (error) => error instanceof ColdStorageError && error.code === "DEVICE_IDENTITY_CONFLICT",
  );

  const manifestPath = path.join(item.destination, ...deviceManifestPath("mac-stable-one").split("/"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.displayName = "Changed Elsewhere";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    () => showDevice(config),
    (error) => error instanceof ColdStorageError && error.code === "DEVICE_IDENTITY_CONFLICT",
  );
});

test("protocol mismatch and unsupported versions fail with stable codes", async () => {
  const item = await fixture();
  await initializeDevice(item.configPath, item.config, {
    apply: true,
    deviceId: "mac-protocol-one",
    displayName: "Protocol Mac",
    platform: "macos",
    now: NOW,
    runRecordId: RUN_ONE,
  });
  const protocolPath = path.join(item.destination, "protocol.json");
  const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
  protocol.volumeId = "019f0000-8888-7999-8aaa-bbbbccccdddd";
  await writeFile(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
  const mismatch = await bridgeDoctor(await loadConfig(item.configPath));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.checks.some((check) => check.code === "PROTOCOL_VOLUME_MISMATCH"), true);

  protocol.volumeId = item.config.destinationId;
  protocol.protocolVersion = 2;
  protocol.minReaderVersion = 2;
  await writeFile(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
  const currentConfig = await loadConfig(item.configPath);
  await assert.rejects(
    () => showDevice(currentConfig),
    (error) => error instanceof ColdStorageError && error.code === "PROTOCOL_VERSION_UNSUPPORTED",
  );
});

test("an interruption after config save resumes with the same stable device ID", async () => {
  const item = await fixture();
  await assert.rejects(
    () =>
      initializeDevice(item.configPath, item.config, {
        apply: true,
        displayName: "Interrupted Mac",
        platform: "macos",
        now: NOW,
        randomUUID: () => "11111111-2222-4333-8444-555566667777",
        afterConfigSaved: async () => {
          throw new Error("synthetic interruption");
        },
      }),
    /synthetic interruption/,
  );
  const saved = await loadConfig(item.configPath);
  assert.equal(saved.device.id, "macos-interrupted-mac-11111111");
  await assert.rejects(
    () => stat(path.join(item.destination, ...deviceManifestPath(saved.device.id).split("/"))),
    { code: "ENOENT" },
  );

  const resumed = await initializeDevice(item.configPath, saved, {
    apply: true,
    now: "2026-08-26T02:02:00Z",
    runRecordId: RUN_TWO,
  });
  assert.equal(resumed.device.id, saved.device.id);
  assert.equal(resumed.created.manifest, true);
  assert.equal((await showDevice(await loadConfig(item.configPath))).device.id, saved.device.id);
});

test("a symlinked device writer tree is rejected", async () => {
  const item = await fixture();
  const outside = path.join(item.base, "outside-devices");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(item.destination, "devices"),
    process.platform === "win32" ? "junction" : undefined,
  );
  await assert.rejects(
    () =>
      initializeDevice(item.configPath, item.config, {
        apply: true,
        deviceId: "mac-symlink-one",
        displayName: "Symlink Mac",
        platform: "macos",
        now: NOW,
        runRecordId: RUN_ONE,
      }),
    (error) => error instanceof ColdStorageError && error.code === "PATH_SYMLINK_UNSAFE",
  );
});

test("CLI device init/show and bridge doctor use the M1 implementation", async () => {
  const item = await fixture();
  const dryRun = captureIo();
  assert.equal(
    await main(
      [
        "device",
        "init",
        "--config",
        item.configPath,
        "--device-id",
        "mac-cli-one",
        "--device-name",
        "CLI Mac",
        "--platform",
        "macos",
        "--json",
      ],
      dryRun.io,
    ),
    0,
  );
  assert.equal(JSON.parse(dryRun.stdout[0]).apply, false);

  const applied = captureIo();
  assert.equal(
    await main(
      [
        "device",
        "init",
        "--config",
        item.configPath,
        "--device-id",
        "mac-cli-one",
        "--device-name",
        "CLI Mac",
        "--platform",
        "macos",
        "--apply",
        "--json",
      ],
      applied.io,
    ),
    0,
  );
  assert.equal(JSON.parse(applied.stdout[0]).device.id, "mac-cli-one");

  const shown = captureIo();
  assert.equal(await main(["device", "show", "--config", item.configPath, "--json"], shown.io), 0);
  assert.equal(JSON.parse(shown.stdout[0]).manifest.deviceId, "mac-cli-one");

  const diagnosed = captureIo();
  assert.equal(await main(["bridge", "doctor", "--config", item.configPath, "--json"], diagnosed.io), 0);
  assert.equal(JSON.parse(diagnosed.stdout[0]).ok, true);
});
