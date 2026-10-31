import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { GhGitHub } from '../src/github.ts';

/**
 * GhGitHub against a fake `gh` on PATH: GitHub as JSON in a file, and every call that writes logged, so these tests
 * cover the real gh calls (which fields are asked for, and what is done with them).
 */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const log = (entry) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(entry) + '\\n');
const pick = (items) => {
  const fields = flag('--json').split(',');
  return items.map((item) => Object.fromEntries(fields.map((field) => [field, item[field]])));
};
const stdin = () => fs.readFileSync(0, 'utf8');
const [a, b, c] = args;
if (a === 'api' && b === 'user') process.stdout.write(state.viewer + '\\n');
else if (a === 'pr' && b === 'list') {
  // Like GitHub, --head matches the branch name, whichever repo the branch is in.
  const status = flag('--state');
  const prs = state.prs.filter((pr) => (flag('--head') === undefined || pr.headRefName === flag('--head')) && (status === 'all' || pr.state === status.toUpperCase()));
  process.stdout.write(JSON.stringify(pick(prs)));
} else if (a === 'api' && args.includes('--slurp')) process.stdout.write(JSON.stringify([state.comments]));
else if (a === 'api' && flag('--method') === 'PATCH') log({ patch: args.at(-3), body: JSON.parse(stdin()).body });
else if (a === 'issue' && b === 'comment') log({ comment: c, body: stdin() });
else if (a === 'pr' && b === 'edit') log({ edit: c, body: stdin() });
else if (a === 'pr' && b === 'ready') log({ ready: c });
else { process.stderr.write('fake gh: unexpected ' + args.join(' ')); process.exit(1); }
`;

type FakePr = { number: number; url: string; isDraft: boolean; headRefName: string; state: string; isCrossRepository: boolean };
type FakeComment = { id: number; body: string; user: { login: string } | null };

let dir: string;
let path: string | undefined;
const github = new GhGitHub('iPhatty/phat-mode');

async function gitHubWith(state: { prs?: FakePr[]; comments?: FakeComment[] }) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({ viewer: 'iPhatty', prs: [], comments: [], ...state }));
  await writeFile(join(dir, 'log.jsonl'), '');
}
const writes = async () =>
  (await readFile(join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

const pr = (number: number, fields: Partial<FakePr> = {}): FakePr => ({
  number,
  url: `https://github.com/iPhatty/phat-mode/pull/${number}`,
  isDraft: false,
  headRefName: 'phat-mode/issue-1',
  state: 'OPEN',
  isCrossRepository: false,
  ...fields,
});

describe('GhGitHub, on a public repo', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phat-gh-'));
    await writeFile(join(dir, 'gh'), FAKE_GH);
    await chmod(join(dir, 'gh'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    process.env.FAKE_GH_STATE = join(dir, 'state.json');
    process.env.FAKE_GH_LOG = join(dir, 'log.jsonl');
  });
  after(async () => {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => gitHubWith({}));

  test('a pull request from a fork is never phat-mode’s, even on a phat-mode/issue-N branch', async () => {
    const fork = pr(10, { isCrossRepository: true });
    const ours = pr(11, { headRefName: 'phat-mode/issue-2' });
    await gitHubWith({ prs: [fork, ours, pr(12, { headRefName: 'phat-mode/issue-3', state: 'CLOSED', isCrossRepository: true })] });

    assert.deepEqual(await github.openPullRequests(), [
      { number: 11, url: ours.url, isDraft: false, branch: 'phat-mode/issue-2' },
    ]);
    assert.equal(await github.findPullRequest('phat-mode/issue-1'), undefined);
    assert.equal(await github.latestPullRequest('phat-mode/issue-3'), undefined);
  });

  test('phat-mode’s own pull requests are still found', async () => {
    const ours = pr(11, { isDraft: true });
    await gitHubWith({ prs: [ours, pr(12, { isCrossRepository: true })] });
    assert.deepEqual(await github.findPullRequest('phat-mode/issue-1'), { number: 11, url: ours.url, isDraft: true });
    assert.deepEqual(await github.latestPullRequest('phat-mode/issue-1'), {
      number: 11,
      url: ours.url,
      isDraft: true,
      state: 'OPEN',
    });
  });

  test('a stranger’s comment carrying phat-mode’s marker is left alone; phat-mode posts its own', async () => {
    await gitHubWith({ comments: [{ id: 5, body: '<!-- phat-mode:plan -->\nhijack', user: { login: 'stranger' } }] });
    await github.upsertComment(1, '<!-- phat-mode:plan -->', 'The plan.');
    assert.deepEqual(await writes(), [{ comment: '1', body: '<!-- phat-mode:plan -->\nThe plan.' }]);
  });

  test('phat-mode’s own marked comment is updated in place', async () => {
    await gitHubWith({
      comments: [
        { id: 5, body: '<!-- phat-mode:plan -->\nhijack', user: { login: 'stranger' } },
        { id: 6, body: '<!-- phat-mode:plan -->\nOld plan.', user: { login: 'iPhatty' } },
        { id: 7, body: 'deleted user', user: null },
      ],
    });
    await github.upsertComment(1, '<!-- phat-mode:plan -->', 'New plan.');
    assert.deepEqual(await writes(), [
      { patch: 'repos/iPhatty/phat-mode/issues/comments/6', body: '<!-- phat-mode:plan -->\nNew plan.' },
    ]);
  });
});
