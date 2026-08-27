#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(root, 'tests');
const testFiles = (await readdir(testsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => path.join(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`No test files found in ${testsDirectory}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else if (result.signal) {
    console.error(`Test runner terminated by ${result.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
