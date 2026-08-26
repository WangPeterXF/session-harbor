import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_KINDS,
  CONTRACT_VERSION,
  ContractValidationError,
  isPortableRelativePath,
  validateContract,
} from "../plugins/session-harbor/scripts/lib/bridge-contracts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXAMPLES = path.join(ROOT, "examples", "contracts");

async function load(name) {
  return JSON.parse(await readFile(path.join(EXAMPLES, name), "utf8"));
}

function contractIssues(value) {
  try {
    validateContract(value);
    return [];
  } catch (error) {
    assert.equal(error instanceof ContractValidationError, true);
    return error.issues;
  }
}

test("all checked-in contract examples validate", async () => {
  const names = (await readdir(EXAMPLES)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    "device.example.json",
    "head-pointer.example.json",
    "memory-snapshot.example.json",
    "run-record.example.json",
    "session-snapshot.example.json",
    "vault-protocol.example.json",
  ]);
  const kinds = [];
  for (const name of names) kinds.push(validateContract(await load(name)).kind);
  assert.deepEqual(new Set(kinds), new Set(CONTRACT_KINDS));
});

test("the JSON Schema is parseable and declares contract v1", async () => {
  const schema = JSON.parse(
    await readFile(path.join(ROOT, "schemas", "session-harbor-contracts-v1.schema.json"), "utf8"),
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$defs.deviceManifest.properties.contractVersion.const, CONTRACT_VERSION);
  assert.equal(schema.oneOf.length, CONTRACT_KINDS.length);
});

test("portable metadata rejects POSIX, Windows, backslash, and traversal paths", () => {
  assert.equal(isPortableRelativePath("devices/mac-one/file.json"), true);
  assert.equal(isPortableRelativePath("/Volumes/CODEX/file.json"), false);
  assert.equal(isPortableRelativePath("C:/SessionHarbor/file.json"), false);
  assert.equal(isPortableRelativePath("devices\\mac-one\\file.json"), false);
  assert.equal(isPortableRelativePath("devices/mac-one/../peer/file.json"), false);
});

test("session snapshots enforce device-owned content-addressed object paths", async () => {
  const snapshot = await load("session-snapshot.example.json");
  snapshot.objects[0].objectPath =
    "devices/windows-example/sessions/objects/sha256/aa/" + `${snapshot.objects[0].sha256}.jsonl`;
  const issues = contractIssues(snapshot);
  assert.equal(issues.some((item) => item.code === "OBJECT_PATH_MISMATCH"), true);
});

test("head pointers cannot point into a peer device tree", async () => {
  const head = await load("head-pointer.example.json");
  head.manifestPath = head.manifestPath.replace("mac-example-air", "windows-example");
  const issues = contractIssues(head);
  assert.equal(issues.some((item) => item.code === "HEAD_PATH_MISMATCH"), true);
});

test("session snapshots reject duplicate source keys and noncanonical hashes", async () => {
  const snapshot = await load("session-snapshot.example.json");
  snapshot.objects.push(structuredClone(snapshot.objects[0]));
  snapshot.objects[1].sessionId = "019f0000-bbbb-7ccc-8ddd-eeeeffffffff";
  snapshot.objects[1].sha256 = snapshot.objects[1].sha256.toUpperCase();
  const issues = contractIssues(snapshot);
  assert.equal(issues.some((item) => item.code === "SHA256"), true);
  assert.equal(issues.some((item) => item.code === "DUPLICATE_SOURCE_KEY"), true);
});

test("memory entries require evidence and reviewed draft metadata is unambiguous", async () => {
  const snapshot = await load("memory-snapshot.example.json");
  snapshot.review.status = "draft";
  snapshot.entries[0].evidence = [];
  const issues = contractIssues(snapshot);
  assert.equal(issues.some((item) => item.code === "TYPE_NULL"), true);
  assert.equal(issues.some((item) => item.code === "EVIDENCE_REQUIRED"), true);
});

test("run records reject machine-specific absolute references", async () => {
  const record = await load("run-record.example.json");
  record.inputRefs = ["C:/Users/example/.codex/sessions/file.jsonl"];
  const issues = contractIssues(record);
  assert.equal(issues.some((item) => item.code === "PORTABLE_PATH"), true);
});

test("unknown fields and unknown contract versions fail closed", async () => {
  const manifest = await load("device.example.json");
  manifest.contractVersion = 2;
  manifest.localCodexHome = "/Users/example/.codex";
  const issues = contractIssues(manifest);
  assert.equal(issues.some((item) => item.code === "EXACT_VALUE"), true);
  assert.equal(issues.some((item) => item.code === "UNKNOWN_FIELD"), true);
});
