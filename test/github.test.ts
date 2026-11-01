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
else if (a === 'issue' && b === 'edit') log({ issueEdit: c, args: args.slice(3), body: stdin() });
else if (a === 'pr' && b === 'edit') log({ edit: c, body: stdin() });
else if (a === 'pr' && b === 'ready') log({ ready: c });
else if (a === 'label' && b === 'list') process.stdout.write(JSON.stringify(state.labels.map((name) => ({ name }))));
else if (a === 'label' && b === 'create' && state.labelError) { process.stderr.write(state.labelError); process.exit(1); }
else if (a === 'label' && b === 'create') log({ label: c, color: flag('--color'), description: flag('--description') });
else if (a === 'pr' && b === 'view') process.stdout.write(JSON.stringify(pick([state.views[c]])[0]));
else if (a === 'pr' && b === 'merge' && state.refuse) { process.stderr.write(state.refuse); process.exit(1); }
else if (a === 'pr' && b === 'merge') log({ merge: args.slice(2) });
else if (a === 'pr' && b === 'comment') log({ prComment: c, body: stdin() });
else { process.stderr.write('fake gh: unexpected ' + args.join(' ')); process.exit(1); }
`;

type FakePr = { number: number; url: string; isDraft: boolean; headRefName: string; state: string; isCrossRepository: boolean };
type FakeComment = { id: number; body: string; user: { login: string } | null };

let dir: string;
let path: string | undefined;
const github = new GhGitHub('iPhatty/phat-mode');

async function gitHubWith(state: {
  prs?: FakePr[];
  comments?: FakeComment[];
  labels?: string[];
  views?: Record<string, unknown>;
  refuse?: string;
  labelError?: string;
}) {
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({ viewer: 'iPhatty', prs: [], comments: [], labels: [], views: {}, ...state }),
  );
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

  test('a pull request’s head commit, when it was made, and every check on it: passed, running or failed', async () => {
    const run = (name: string, status: string, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion });
    const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state });
    await gitHubWith({
      views: {
        40: {
          body: 'The description',
          headRefOid: 'bbb',
          commits: [
            { oid: 'aaa', committedDate: '2026-10-31T10:00:00Z' },
            { oid: 'bbb', committedDate: '2026-10-31T12:00:00Z' },
          ],
          statusCheckRollup: [
            run('test', 'COMPLETED', 'SUCCESS'),
            run('lint', 'COMPLETED', 'SKIPPED'),
            run('docs', 'COMPLETED', 'NEUTRAL'),
            run('build', 'IN_PROGRESS'),
            run('e2e', 'QUEUED'),
            run('deploy', 'COMPLETED', 'FAILURE'),
            run('slow', 'COMPLETED', 'TIMED_OUT'),
            run('stop', 'COMPLETED', 'CANCELLED'),
            status('ci/legacy', 'SUCCESS'),
            status('ci/pending', 'PENDING'),
            status('ci/broken', 'ERROR'),
            status('ci/red', 'FAILURE'),
          ],
        },
      },
    });
    assert.deepEqual(await github.pullRequestStatus(40), {
      body: 'The description',
      head: { sha: 'bbb', committedAt: '2026-10-31T12:00:00Z' },
      checks: [
        { name: 'test', state: 'passed' },
        { name: 'lint', state: 'passed' },
        { name: 'docs', state: 'passed' },
        { name: 'build', state: 'running' },
        { name: 'e2e', state: 'running' },
        { name: 'deploy', state: 'failed' },
        { name: 'slow', state: 'failed' },
        { name: 'stop', state: 'failed' },
        { name: 'ci/legacy', state: 'passed' },
        { name: 'ci/pending', state: 'running' },
        { name: 'ci/broken', state: 'failed' },
        { name: 'ci/red', state: 'failed' },
      ],
    });
  });

  test('merges by squashing exactly the given commit, deletes the branch, and never bypasses protection', async () => {
    await github.mergePullRequest(40, 'bbb');
    await github.commentOnPullRequest(40, 'Merged.');
    assert.deepEqual(await writes(), [
      { merge: ['40', '-R', 'iPhatty/phat-mode', '--squash', '--delete-branch', '--match-head-commit', 'bbb'] },
      { prComment: '40', body: 'Merged.' },
    ]);
  });

  test('a merge GitHub refuses fails with GitHub’s reason', async () => {
    await gitHubWith({ refuse: 'Pull request #40 is not mergeable: the base branch policy prohibits the merge.' });
    await assert.rejects(github.mergePullRequest(40, 'bbb'), /base branch policy prohibits the merge/);
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

  test('editIssueBody replaces the issue’s body, sent on stdin', async () => {
    await github.editIssueBody(4, '> *Shaped by phat-mode (AI) from #4.*\n\n## Original request\n\nGreet `learners`.');
    assert.deepEqual(await writes(), [
      { issueEdit: '4', args: ['-R', 'iPhatty/phat-mode', '--body-file', '-'], body: '> *Shaped by phat-mode (AI) from #4.*\n\n## Original request\n\nGreet `learners`.' },
    ]);
  });

  test('missingLabels: the names the repo does not have, without creating any', async () => {
    await gitHubWith({ labels: ['ready-for-agent', 'phat-mode:working'] });
    const fresh = new GhGitHub('iPhatty/phat-mode');
    assert.deepEqual(await fresh.missingLabels(['ready-for-agent', 'agent-mode', 'phat-mode:shaped']), ['agent-mode', 'phat-mode:shaped']);
    assert.deepEqual(await writes(), []);
  });

  test('ensureLabels: creates only the missing ones, with their colour and description', async () => {
    await gitHubWith({ labels: ['ready-for-agent'] });
    const fresh = new GhGitHub('iPhatty/phat-mode');
    const result = await fresh.ensureLabels([
      { name: 'ready-for-agent', color: '0E8A16', description: 'Ready' },
      { name: 'needs-info', color: 'D93F0B', description: 'Waiting on reporter' },
    ]);
    assert.deepEqual(result, { created: ['needs-info'], failed: [] });
    assert.deepEqual(await writes(), [{ label: 'needs-info', color: 'D93F0B', description: 'Waiting on reporter' }]);
  });

  test('ensureLabels: a label it could not create is reported as failed, with GitHub’s reason, and still missing', async () => {
    await gitHubWith({ labelError: 'HTTP 403: Resource not accessible by integration' });
    const fresh = new GhGitHub('iPhatty/phat-mode');
    const result = await fresh.ensureLabels([{ name: 'needs-info', color: 'D93F0B', description: 'Waiting on reporter' }]);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.failed.map((failure) => failure.name), ['needs-info']);
    assert.match(result.failed[0]!.reason, /403/);
    assert.deepEqual(await fresh.missingLabels(['needs-info']), ['needs-info']);
  });

  test('ensureLabels: a label that turns out to exist already (beyond the listed ones) is neither created nor failed', async () => {
    await gitHubWith({ labelError: 'label with name "needs-info" already exists; use `--force` to update its color and description' });
    const fresh = new GhGitHub('iPhatty/phat-mode');
    const result = await fresh.ensureLabels([{ name: 'needs-info', color: 'D93F0B', description: 'Waiting on reporter' }]);
    assert.deepEqual(result, { created: [], failed: [] });
  });
});
