import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeStorage,
  normalizeConfig,
  pathExists,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import { runRetentionPolicy } from "../plugins/session-harbor/scripts/lib/retention-runner.mjs";
import { readSessionHead } from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";
import { policyArguments, renderLaunchAgent } from "../plugins/session-harbor/scripts/launchagent.mjs";
import {
  renderWindowsTask,
  writeWindowsTaskXml,
} from "../plugins/session-harbor/scripts/windows-task.mjs";
import { main } from "../plugins/session-harbor/scripts/session-harbor.mjs";

const SESSION_ID = "019f4000-1111-7111-8111-111111111111";

test("macOS schedule encodes publication and reclamation as explicit scopes", () => {
  const plist = renderLaunchAgent({
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/SessionHarbor/session-harbor.mjs",
    configPath: "/Users/example/.config/session-harbor/config.json",
    hour: 4,
    minute: 15,
    publish: true,
    reclaim: true,
    confirmDeleteLocal: true,
  });
  assert.match(plist, /<string>policy<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>--apply<\/string>/);
  assert.match(plist, /<string>--publish<\/string>/);
  assert.match(plist, /<string>--reclaim<\/string>/);
  assert.match(plist, /<string>--confirm-delete-local<\/string>/);
  assert.match(plist, /<key>StartOnMount<\/key><true\/>/);
  assert.match(plist, /<key>Weekday<\/key><integer>1<\/integer>/);
  assert.match(plist, /<integer>4<\/integer>/);
  assert.match(plist, /<integer>15<\/integer>/);
});

test("Windows schedule is least-privilege and quotes paths with spaces", () => {
  const xml = renderWindowsTask({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Session Harbor\\session-harbor.mjs",
    configPath: "C:\\Users\\Example User\\.config\\session-harbor\\config.json",
    hour: 5,
    minute: 45,
    publish: true,
    reclaim: false,
  });
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /2026-01-01T05:45:00/);
  assert.match(xml, /<ScheduleByWeek>/);
  assert.match(xml, /<Monday\/>/);
  assert.match(xml, /<Interval>PT15M<\/Interval>/);
  assert.match(xml, /&quot;C:\\Session Harbor\\session-harbor\.mjs&quot;/);
  assert.match(xml, /backup run --apply --if-available/);
  assert.doesNotMatch(xml, /--reclaim/);
});

test("Windows task XML is persisted as BOM-prefixed UTF-16LE", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-task-xml-"));
  const xmlPath = path.join(base, "task.xml");
  const xml = renderWindowsTask({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Session Harbor\\session-harbor.mjs",
    configPath: "C:\\Users\\Example User\\config.json",
  });
  await writeWindowsTaskXml(xmlPath, xml);
  const bytes = await readFile(xmlPath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString("utf16le"), xml);
});

test("scheduler argument builder defaults to all-session backup without cleanup", () => {
  const base = policyArguments({ nodePath: "node", cliPath: "cli.mjs", configPath: "config.json" });
  assert.deepEqual(base, [
    "node",
    "cli.mjs",
    "backup",
    "run",
    "--apply",
    "--if-available",
    "--config",
    "config.json",
  ]);
});

test("non-JSON policy output stays compact for scheduler logs", async () => {
  const item = await fixture();
  const stdout = [];
  const stderr = [];
  const code = await main(
    ["policy", "plan", "--publish", "--config", item.configPath],
    {
      log: (...parts) => stdout.push(parts.join(" ")),
      error: (...parts) => stderr.push(parts.join(" ")),
    },
  );
  const output = stdout.join("\n");
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(output, /Retention policy dry-run result:/);
  assert.match(output, /archive: 1 candidate\(s\)/);
  assert.match(output, /publish: 1 object\(s\)/);
  assert.doesNotMatch(output, /privateObjects|sourcePath|items/);
  assert.ok(output.length < 1000);
});

test("policy plan writes nothing; scoped apply archives, publishes, then separately reclaims", async () => {
  const item = await fixture();
  const plan = await runRetentionPolicy(item.config, {
    publish: true,
    reclaim: false,
    now: "2026-08-20T00:00:00Z",
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(plan.apply, false);
  assert.equal(await pathExists(path.join(item.destination, "catalog-v1.json")), false);
  assert.equal((await readSessionHead(item.config)), null);

  const applied = await runRetentionPolicy(item.config, {
    apply: true,
    publish: true,
    reclaim: false,
    now: "2026-08-20T00:00:00Z",
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.archive.copied, 1);
  assert.equal(applied.sync.counts.objectsPublished, 0, "archive and sync share one object");
  assert.equal((await stat(item.source)).isFile(), true);
  assert.equal((await readSessionHead(item.config)).manifest.objects.length, 1);

  const reclaimed = await runRetentionPolicy(item.config, {
    apply: true,
    publish: false,
    reclaim: true,
    confirmDeleteLocal: true,
    now: "2026-08-22T00:00:00Z",
    nowMs: Date.parse("2026-08-22T00:00:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(reclaimed.reclaim.reclaimed, 1);
  assert.equal(await pathExists(item.source), false);
  const afterReclaim = await runRetentionPolicy(item.config, {
    apply: true,
    publish: true,
    reclaim: false,
    now: "2026-08-23T00:00:00Z",
    nowMs: Date.parse("2026-08-23T00:00:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(afterReclaim.sync.unchanged, true, "local deletion must not propagate to the session head");
  assert.equal((await readSessionHead(item.config)).manifest.objects.length, 1);
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-policy-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  const day = path.join(codexHome, "sessions", "2026", "08", "01");
  await mkdir(day, { recursive: true });
  const source = path.join(day, `rollout-2026-08-01T00-00-00-${SESSION_ID}.jsonl`);
  await writeFile(
    source,
    `${JSON.stringify({ type: "session_meta", payload: { id: SESSION_ID } })}\n`,
  );
  await utimes(source, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
  const input = normalizeConfig({
    codexHome,
    destination,
    roots: ["sessions", "archived_sessions"],
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    retention: {
      archiveAfterDays: 10,
      localGraceDays: 1,
      reclaimAction: "delete",
      autoReclaim: false,
    },
    device: { id: "mac-policy", displayName: "Policy Mac", platform: "macos" },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-19T00:00:00Z",
    runRecordId: "019f4000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { base, codexHome, destination, configPath, config, source };
}
