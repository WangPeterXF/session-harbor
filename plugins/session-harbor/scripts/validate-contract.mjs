#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ContractValidationError, validateContract } from "./lib/bridge-contracts.mjs";

export async function main(argv = process.argv.slice(2), io = console) {
  const asJson = argv.includes("--json");
  const positionals = argv.filter((value) => value !== "--json");
  const files = positionals.length > 0 ? positionals.map((value) => path.resolve(value)) : await exampleFiles();
  const results = [];

  for (const file of files) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      validateContract(value);
      results.push({ file, ok: true, kind: value.kind, contractVersion: value.contractVersion });
    } catch (error) {
      const issues =
        error instanceof ContractValidationError
          ? error.issues
          : [{ path: "$", code: error.code || "PARSE_ERROR", message: error.message }];
      results.push({ file, ok: false, issues });
    }
  }

  if (asJson) {
    io.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
  } else {
    for (const result of results) {
      if (result.ok) {
        io.log(`OK ${result.kind} ${result.file}`);
        continue;
      }
      io.error(`INVALID ${result.file}`);
      for (const item of result.issues) io.error(`  ${item.code} ${item.path}: ${item.message}`);
    }
  }
  return results.every((result) => result.ok) ? 0 : 2;
}

async function exampleFiles() {
  const directory = fileURLToPath(new URL("../../../examples/contracts/", import.meta.url));
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return names.map((name) => path.join(directory, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`UNEXPECTED_ERROR: ${error.message}`);
      process.exitCode = 1;
    });
}
