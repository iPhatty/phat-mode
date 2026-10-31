import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectCommands, settingsFile } from '../src/init.ts';
import { parseIssueRef } from '../src/repos.ts';

describe('parseIssueRef', () => {
  test('a number is an issue in the repo of this folder', () => {
    assert.deepEqual(parseIssueRef('12', 'o/r'), { repo: 'o/r', issue: 12 });
    assert.deepEqual(parseIssueRef('#12', 'o/r'), { repo: 'o/r', issue: 12 });
  });

  test('owner/name#12 and the issue URL work anywhere', () => {
    assert.deepEqual(parseIssueRef('iPhatty/phatty-lingo#2', undefined), { repo: 'iPhatty/phatty-lingo', issue: 2 });
    assert.deepEqual(parseIssueRef('https://github.com/iPhatty/phatty-lingo/issues/2', 'o/r'), { repo: 'iPhatty/phatty-lingo', issue: 2 });
  });

  test('a number outside a clone, or something else, is explained', () => {
    assert.throws(() => parseIssueRef('12', undefined), /which repo\? Run this inside a clone of it, or write owner\/name#12/);
    assert.throws(() => parseIssueRef('twelve', 'o/r'), /is not an issue/);
    assert.throws(() => parseIssueRef('0', 'o/r'), /not an issue number/);
  });
});

describe('detectCommands', () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'phat-detect-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return detectCommands(dir);
  }
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

  test('npm with a check script', async () => {
    const found = await repo({ 'package.json': pkg({ check: 'x' }), 'package-lock.json': '{}' });
    assert.equal(found.installCommand, 'npm ci');
    assert.equal(found.checkCommand, 'npm run check');
  });

  test('no check script: lint, typecheck and test combined, with the package manager of the lockfile', async () => {
    const found = await repo({ 'package.json': pkg({ test: 'vitest', lint: 'eslint .', build: 'x', typecheck: 'tsc' }), 'pnpm-lock.yaml': '' });
    assert.equal(found.installCommand, 'pnpm install --frozen-lockfile');
    assert.equal(found.checkCommand, 'pnpm run lint && pnpm run typecheck && pnpm test');
  });

  test("yarn berry, bun, and npm's placeholder test script", async () => {
    assert.equal((await repo({ 'package.json': pkg({}), 'yarn.lock': '', '.yarnrc.yml': '' })).installCommand, 'yarn install --immutable');
    assert.equal((await repo({ 'package.json': pkg({ test: 'bun test' }), 'bun.lock': '' })).checkCommand, 'bun run test');
    const placeholder = await repo({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }), 'package-lock.json': '{}' });
    assert.equal(placeholder.checkCommand, undefined, 'nothing to check: init asks');
  });

  test('no lockfile is flagged', async () => {
    const found = await repo({ 'package.json': pkg({ check: 'x' }) });
    assert.equal(found.installCommand, 'npm install');
    assert.ok(found.notes.some((note) => /No lockfile/.test(note)));
  });

  test('Rust, Go and make check; nothing known: no suggestion', async () => {
    assert.equal((await repo({ 'Cargo.toml': '' })).checkCommand, 'cargo clippy --all-targets -- -D warnings && cargo test');
    assert.equal((await repo({ 'go.mod': '' })).checkCommand, 'go vet ./... && go test ./...');
    assert.equal((await repo({ Makefile: 'build:\n\tx\ncheck: build\n\ty\n' })).checkCommand, 'make check');
    assert.deepEqual(await repo({ 'README.md': '' }), { notes: ['No package.json, Cargo.toml, go.mod or Makefile check target found'] });
  });

  test('the settings file holds only what was decided', () => {
    assert.equal(settingsFile({ installCommand: 'npm ci', checkCommand: 'npm run check' }), '{\n  "installCommand": "npm ci",\n  "checkCommand": "npm run check"\n}\n');
  });
});
