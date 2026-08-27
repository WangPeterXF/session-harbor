import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('repository agent guidance stays concise and routes to authoritative safety docs', async () => {
  const guidancePath = path.join(root, 'AGENTS.md');
  const [guidance, details] = await Promise.all([read('AGENTS.md'), stat(guidancePath)]);

  assert.ok(details.size < 32 * 1024, 'AGENTS.md must stay below the default Codex project-doc cap');
  assert.match(guidance, /docs\/threat-model\.md/);
  assert.match(guidance, /npm run check/);
  assert.match(guidance, /Backup must never imply cleanup/);
  assert.match(guidance, /Do not\s+describe it as OSI open source/);
});

test('plugin public metadata has valid policy URLs, bundled assets, and at most three prompts', async () => {
  const manifest = JSON.parse(await read('plugins/session-harbor/.codex-plugin/plugin.json'));

  assert.equal(manifest.name, 'session-harbor');
  assert.match(manifest.interface.websiteURL, /^https:\/\//);
  assert.match(manifest.interface.privacyPolicyURL, /^https:\/\//);
  assert.match(manifest.interface.termsOfServiceURL, /^https:\/\//);
  assert.ok(manifest.interface.defaultPrompt.length > 0);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);

  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    const asset = manifest.interface[key].replace(/^\.\//, 'plugins/session-harbor/');
    const details = await stat(path.join(root, asset));
    assert.ok(details.size > 0, `${key} must point to a non-empty bundled file`);
  }
});

test('discovery evals contain five positive and three negative unique cases', async () => {
  const evals = JSON.parse(await read('evals/plugin-discovery.json'));
  const ids = new Set(evals.cases.map((entry) => entry.id));
  const positives = evals.cases.filter((entry) => entry.kind === 'positive');
  const negatives = evals.cases.filter((entry) => entry.kind === 'negative');

  assert.equal(ids.size, evals.cases.length);
  assert.equal(positives.length, 5);
  assert.equal(negatives.length, 3);
  assert.ok(positives.every((entry) => entry.expectedSelection === 'session-harbor'));
  assert.ok(negatives.every((entry) => entry.expectedSelection === 'none'));
});

test('Pages discovery surfaces allow search retrieval without opting into GPTBot training crawl', async () => {
  const [index, robots, sitemap] = await Promise.all([
    read('docs/index.html'),
    read('docs/robots.txt'),
    read('docs/sitemap.xml')
  ]);

  assert.match(index, /rel="describedby"[^>]+llms\.txt/);
  assert.match(index, /type="application\/ld\+json"/);
  assert.match(robots, /User-agent: OAI-SearchBot\nAllow: \//);
  assert.match(robots, /User-agent: GPTBot\nDisallow: \//);
  assert.match(sitemap, /https:\/\/wangpeterxf\.github\.io\/session-harbor\/llms\.txt/);
});
