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
const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
if (a === 'api' && b === 'user') process.stdout.write(state.viewer + '\\n');
else if (a === 'api' && /\\/commits\\/[^/]+$/.test(path) && flag('--jq') === '.sha') process.stdout.write(state.commits[path.split('/').pop()] + '\\n');
else if (a === 'api' && args.includes('--slurp') && path.includes('/check-runs')) {
  log({ checkRuns: path });
  process.stdout.write(JSON.stringify(state.checkRunPages));
} else if (a === 'api' && path.endsWith('/status') || a === 'api' && path.includes('/status?')) {
  log({ status: path });
  process.stdout.write(JSON.stringify({ statuses: state.statuses }));
} else if (a === 'api' && path.endsWith('/logs')) process.stdout.write(state.logs[path.split('/')[5]]);
else if (a === 'api' && flag('--method') === 'POST' && path.endsWith('/rerun-failed-jobs')) log({ rerun: path });
else if (a === 'api' && /\\/actions\\/runs\\/\\d+$/.test(path) && flag('--jq') === '.run_attempt') process.stdout.write(state.attempts[path.split('/').pop()] + '\\n');
else if (a === 'api' && args.includes('--slurp') && path.includes('/sub_issues?')) {
  log({ subIssues: path });
  process.stdout.write(JSON.stringify(state.subIssuePages));
} else if (a === 'api' && args.includes('--slurp') && path.includes('/issues?')) {
  log({ list: path });
  process.stdout.write(JSON.stringify([state.issues]));
} else if (a === 'api' && flag('--method') === 'POST' && path.endsWith('/issues')) {
  log({ create: JSON.parse(stdin()), jq: flag('--jq') });
  process.stdout.write(state.nextNumber + '\\n');
} else if (a === 'api' && flag('--method') === 'POST' && args.includes('-F')) log({ post: path, field: args[args.indexOf('-F') + 1] });
else if (a === 'api' && path.endsWith('/parent')) {
  const parent = state.parents[path.split('/')[4]];
  if (parent === undefined) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
  process.stdout.write(parent + '\\n');
} else if (a === 'api' && path.endsWith('/dependencies/blocked_by')) process.stdout.write(JSON.stringify(state.blockedBy[path.split('/')[4]] ?? []));
else if (a === 'api' && /\\/issues\\/\\d+$/.test(path) && flag('--jq') === '.id') process.stdout.write(state.ids[path.split('/')[4]] + '\\n');
else if (a === 'api' && /\\/issues\\/\\d+$/.test(path) && flag('--jq') === '.state') {
  const issueState = state.issueStates[path.split('/')[4]];
  if (issueState === undefined) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
  process.stdout.write(issueState + '\\n');
}
else if (a === 'pr' && b === 'list') {
  // Like GitHub, --head matches the branch name, whichever repo the branch is in.
  const status = flag('--state');
  const prs = state.prs.filter((pr) => (flag('--head') === undefined || pr.headRefName === flag('--head')) && (status === 'all' || pr.state === status.toUpperCase()));
  process.stdout.write(JSON.stringify(pick(prs)));
} else if (a === 'api' && args.includes('--slurp')) process.stdout.write(JSON.stringify([state.comments]));
else if (a === 'api' && flag('--method') === 'PATCH') log({ patch: args.at(-3), body: JSON.parse(stdin()).body });
else if (a === 'issue' && b === 'comment') log({ comment: c, body: stdin() });
else if (a === 'issue' && b === 'close') log({ close: c, args: args.slice(3) });
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
type FakeIssue = { number: number; body: string | null; user: { login: string } | null; pull_request?: object };
type FakeComment = { id: number; body: string; user: { login: string } | null; created_at?: string };

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
  issues?: FakeIssue[];
  nextNumber?: number;
  ids?: Record<string, number>;
  parents?: Record<string, number>;
  blockedBy?: Record<string, { number: number; state: string }[]>;
  issueStates?: Record<string, 'open' | 'closed'>;
  subIssuePages?: { number: number; title: string; state: string }[][];
  commits?: Record<string, string>;
  checkRunPages?: { check_runs: unknown[] }[];
  statuses?: unknown[];
  logs?: Record<string, string>;
  attempts?: Record<string, number>;
}) {
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({ viewer: 'iPhatty', prs: [], comments: [], labels: [], views: {}, issues: [], ids: {}, parents: {}, blockedBy: {}, issueStates: {}, subIssuePages: [], commits: {}, checkRunPages: [], statuses: [], logs: {}, attempts: {}, ...state }),
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
      // Not given by the fake: unknown mergeability, no labels and no reviews.
      mergeable: 'UNKNOWN',
      mergeState: 'UNKNOWN',
      labels: [],
      reviews: [],
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

  test('commitChecks: a branch or sha’s commit, with every check run and status, each with its description, link, and Actions job', async () => {
    const actions = (id: number, name: string, status: string, conclusion: string | null, output = { title: null as string | null, summary: null as string | null }) => ({
      id,
      name,
      status,
      conclusion,
      details_url: `https://github.com/iPhatty/phat-mode/actions/runs/77/job/${id}`,
      html_url: `https://github.com/iPhatty/phat-mode/runs/${id}`,
      app: { slug: 'github-actions' },
      output,
    });
    await gitHubWith({
      commits: { main: 'f00d' },
      checkRunPages: [
        { check_runs: [actions(11, 'test', 'completed', 'failure', { title: 'Process completed with exit code 1.', summary: 'ignored' }), actions(12, 'lint', 'completed', 'success')] },
        {
          check_runs: [
            actions(13, 'build', 'in_progress', null),
            {
              id: 99,
              name: 'codecov',
              status: 'completed',
              conclusion: 'failure',
              details_url: null,
              html_url: 'https://codecov.test/99',
              app: { slug: 'codecov' },
              output: { title: null, summary: 'Coverage dropped' },
            },
          ],
        },
      ],
      statuses: [
        { context: 'ci/legacy', state: 'success', description: 'All good', target_url: 'https://ci.test/1' },
        { context: 'ci/pending', state: 'pending', description: null, target_url: null },
        { context: 'ci/broken', state: 'error', description: 'Could not start', target_url: 'https://ci.test/3' },
        { context: 'ci/red', state: 'failure', description: 'Tests failed', target_url: 'https://ci.test/4' },
      ],
    });
    assert.deepEqual(await github.commitChecks('main'), {
      sha: 'f00d',
      checks: [
        {
          name: 'test',
          state: 'failed',
          description: 'Process completed with exit code 1.',
          url: 'https://github.com/iPhatty/phat-mode/actions/runs/77/job/11',
          job: { id: 11, runId: 77 },
        },
        { name: 'lint', state: 'passed', description: '', url: 'https://github.com/iPhatty/phat-mode/actions/runs/77/job/12', job: { id: 12, runId: 77 } },
        { name: 'build', state: 'running', description: '', url: 'https://github.com/iPhatty/phat-mode/actions/runs/77/job/13', job: { id: 13, runId: 77 } },
        { name: 'codecov', state: 'failed', description: 'Coverage dropped', url: 'https://codecov.test/99' },
        { name: 'ci/legacy', state: 'passed', description: 'All good', url: 'https://ci.test/1' },
        { name: 'ci/pending', state: 'running', description: '', url: '' },
        { name: 'ci/broken', state: 'failed', description: 'Could not start', url: 'https://ci.test/3' },
        { name: 'ci/red', state: 'failed', description: 'Tests failed', url: 'https://ci.test/4' },
      ],
    });
    // The checks of the commit itself, every page of them.
    assert.deepEqual(await writes(), [
      { checkRuns: 'repos/iPhatty/phat-mode/commits/f00d/check-runs?per_page=100' },
      { status: 'repos/iPhatty/phat-mode/commits/f00d/status?per_page=100' },
    ]);
  });

  test('jobLog: the full log of an Actions job', async () => {
    await gitHubWith({ logs: { '11': 'line 1\nline 2\n' } });
    assert.equal(await github.jobLog(11), 'line 1\nline 2\n');
  });

  test('rerunFailedJobs: asks GitHub to rerun the failed jobs of one workflow run', async () => {
    await github.rerunFailedJobs(77);
    assert.deepEqual(await writes(), [{ rerun: 'repos/iPhatty/phat-mode/actions/runs/77/rerun-failed-jobs' }]);
  });

  test('runAttempt: a workflow run’s attempt, one more after each rerun', async () => {
    await gitHubWith({ attempts: { '77': 2 } });
    assert.equal(await github.runAttempt(77), 2);
  });

  test('a pull request’s mergeability, merge state, labels and reviews, with each review’s author, state and time', async () => {
    await gitHubWith({
      views: {
        41: {
          body: '',
          headRefOid: 'ccc',
          commits: [{ oid: 'ccc', committedDate: '2026-10-31T12:00:00Z' }],
          statusCheckRollup: null,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          labels: [{ name: 'ready-for-human' }, { name: 'phat-mode:stuck' }],
          reviews: [
            { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-31T13:00:00Z' },
            { author: null, state: 'COMMENTED', submittedAt: '2026-10-31T14:00:00Z' },
          ],
        },
      },
    });
    const status = await github.pullRequestStatus(41);
    assert.equal(status.mergeable, 'CONFLICTING');
    assert.equal(status.mergeState, 'DIRTY');
    assert.deepEqual(status.labels, ['ready-for-human', 'phat-mode:stuck']);
    assert.deepEqual(status.reviews, [
      { author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-31T13:00:00Z' },
      { author: 'ghost', state: 'COMMENTED', submittedAt: '2026-10-31T14:00:00Z' },
    ]);
  });

  test('phatModeComments: only the comments phat-mode posted, oldest first, never a stranger’s', async () => {
    await gitHubWith({
      comments: [
        { id: 7, body: '<!-- phat-mode:repair n=1 sha=bbb cause=conflicts round=1 -->\nsecond', user: { login: 'iPhatty' }, created_at: '2026-10-31T13:00:00Z' },
        { id: 5, body: '<!-- phat-mode:repair n=1 sha=aaa cause=conflicts round=1 -->\nforged', user: { login: 'stranger' }, created_at: '2026-10-31T11:00:00Z' },
        { id: 6, body: 'first', user: { login: 'iPhatty' }, created_at: '2026-10-31T12:00:00Z' },
        { id: 8, body: 'deleted user', user: null, created_at: '2026-10-31T14:00:00Z' },
      ],
    });
    assert.deepEqual(await github.phatModeComments(40), [
      { body: 'first', createdAt: '2026-10-31T12:00:00Z' },
      { body: '<!-- phat-mode:repair n=1 sha=bbb cause=conflicts round=1 -->\nsecond', createdAt: '2026-10-31T13:00:00Z' },
    ]);
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

  test('createIssue sends the title and body, and returns the new number', async () => {
    await gitHubWith({ nextNumber: 31 });
    assert.equal(await github.createIssue({ title: 'Store greetings', body: '## Parent\n\n#30' }), 31);
    assert.deepEqual(await writes(), [{ create: { title: 'Store greetings', body: '## Parent\n\n#30' }, jq: '.number' }]);
  });

  test('findIssueByMarker: only issues opened by the gh user, never a stranger’s or a pull request', async () => {
    const marker = '<!-- phat-mode:ticket:30:0 -->';
    await gitHubWith({
      issues: [
        { number: 40, body: `${marker}\nforged`, user: { login: 'mallory' } },
        { number: 41, body: `${marker}\nmine, but a PR`, user: { login: 'iPhatty' }, pull_request: {} },
        { number: 42, body: null, user: { login: 'iPhatty' } },
        { number: 43, body: '<!-- phat-mode:ticket:30:01 -->', user: { login: 'iPhatty' } },
      ],
    });
    assert.equal(await github.findIssueByMarker(marker), undefined);
    const [listed] = await writes();
    assert.match(listed.list, /^repos\/iPhatty\/phat-mode\/issues\?state=all&creator=iPhatty&per_page=100$/);

    await gitHubWith({
      issues: [
        { number: 40, body: `${marker}\nforged`, user: { login: 'mallory' } },
        { number: 44, body: `> AI\n${marker}\n## Parent`, user: { login: 'iPhatty' } },
      ],
    });
    assert.equal(await github.findIssueByMarker(marker), 44);
  });

  test('addSubIssue posts the child’s database id as an integer, unless it is linked already', async () => {
    await gitHubWith({ ids: { 31: 9001 }, parents: { 32: 30 } });
    await github.addSubIssue(30, 31);
    await github.addSubIssue(30, 32);
    assert.deepEqual(await writes(), [{ post: 'repos/iPhatty/phat-mode/issues/30/sub_issues', field: 'sub_issue_id=9001' }]);
  });

  test('addBlockedBy posts the blocker’s database id as an integer, unless the edge exists already', async () => {
    await gitHubWith({ ids: { 31: 9001, 32: 9002 }, blockedBy: { 33: [{ number: 32, state: 'open' }] } });
    await github.addBlockedBy(33, 32);
    await github.addBlockedBy(33, 31);
    assert.deepEqual(await writes(), [
      { post: 'repos/iPhatty/phat-mode/issues/33/dependencies/blocked_by', field: 'issue_id=9001' },
    ]);
  });

  test('openBlockers: an open blocker whose newest phat-mode pull request merged no longer stands in the way', async () => {
    await gitHubWith({
      // Native edges for #50; #43 is closed already.
      blockedBy: {
        50: [
          { number: 40, state: 'open' },
          { number: 41, state: 'open' },
          { number: 42, state: 'open' },
          { number: 43, state: 'closed' },
        ],
      },
      // `Blocked by` lines; #49 does not resolve.
      issueStates: { 44: 'open', 45: 'open', 46: 'open', 47: 'open' },
      prs: [
        pr(100, { headRefName: 'phat-mode/issue-40', state: 'MERGED' }), // merged, GitHub has not closed #40 yet
        pr(101, { headRefName: 'phat-mode/issue-41', state: 'OPEN' }), // waiting for merge
        pr(102, { headRefName: 'phat-mode/issue-42', state: 'CLOSED' }), // closed without merging: with a human
        pr(103, { headRefName: 'phat-mode/issue-44', state: 'MERGED' }),
        pr(104, { headRefName: 'phat-mode/issue-44', state: 'OPEN' }), // the newest one decides
        pr(105, { headRefName: 'phat-mode/issue-46', state: 'MERGED', isCrossRepository: true }), // a fork's is never phat-mode's
        pr(106, { headRefName: 'phat-mode/issue-47', state: 'MERGED' }), // merged, through a `Blocked by` line
      ],
    });
    // #45: a human's issue, with no phat-mode branch.
    assert.deepEqual(await github.openBlockers(50, [44, 45, 46, 47, 49]), [41, 42, 44, 45, 46]);
    assert.deepEqual(await writes(), []);
  });

  test('listSubIssues: every page, with GitHub’s state as OPEN or CLOSED, lowest number first', async () => {
    await gitHubWith({
      subIssuePages: [
        [{ number: 12, title: 'Second', state: 'open' }],
        [{ number: 11, title: 'First', state: 'closed' }],
      ],
    });
    assert.deepEqual(await github.listSubIssues(10), [
      { number: 11, title: 'First', state: 'CLOSED' },
      { number: 12, title: 'Second', state: 'OPEN' },
    ]);
    assert.deepEqual(await writes(), [{ subIssues: 'repos/iPhatty/phat-mode/issues/10/sub_issues?per_page=100' }]);
  });

  test('closeIssue posts its comment first, then closes the issue as completed', async () => {
    await github.closeIssue(10, '<!-- phat-mode:shape-closed -->', 'All done.');
    assert.deepEqual(await writes(), [
      { comment: '10', body: '<!-- phat-mode:shape-closed -->\nAll done.' },
      { close: '10', args: ['-R', 'iPhatty/phat-mode', '--reason', 'completed'] },
    ]);
  });
});
