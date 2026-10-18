import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { setToolLogger } from '../src/agents.ts';
import { branchFor, type Config, defaultConfig, paths } from '../src/config.ts';
import { run } from '../src/exec.ts';
import type { GitHub, Issue, PullRequest, StatusLabel } from '../src/github.ts';
import { openPhatMode } from '../src/harness.ts';
import { LockedError } from '../src/lock.ts';
import { silentLogger } from '../src/log.ts';
import type { PipelineResult, Services } from '../src/pipeline.ts';
import { type CheckResult, type Checks, GitWorkspaces } from '../src/workspace.ts';

const context = BACKGROUND_CONTEXT;
setToolLogger(silentLogger);

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeGitHub implements GitHub {
  issues = new Map<number, Issue>();
  comments: { issue: number; marker: string; body: string }[] = [];
  commentWrites = 0;
  prs: (PullRequest & { branch: string; base: string; title: string; body: string })[] = [];
  status = new Map<number, StatusLabel>();

  addIssue(number: number, fields: Partial<Issue> = {}) {
    this.issues.set(number, {
      number,
      title: `Issue ${number}`,
      body: 'Add a hello file.',
      author: 'iPhatty',
      state: 'OPEN',
      url: `https://github.test/issues/${number}`,
      labels: [],
      ...fields,
    });
  }
  async getIssue(number: number) {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  }
  async upsertComment(issue: number, marker: string, body: string) {
    this.commentWrites++;
    const existing = this.comments.find((comment) => comment.issue === issue && comment.marker === marker);
    if (existing) existing.body = body;
    else this.comments.push({ issue, marker, body });
  }
  async findPullRequest(branch: string) {
    return this.prs.find((pr) => pr.branch === branch);
  }
  async createDraftPullRequest(options: { branch: string; base: string; title: string; body: string }) {
    const pr = { number: this.prs.length + 1, url: `https://github.test/pull/${this.prs.length + 1}`, ...options };
    this.prs.push(pr);
    return pr;
  }
  async updatePullRequestBody(number: number, body: string) {
    this.prs.find((pr) => pr.number === number)!.body = body;
  }
  async setStatus(issue: number, status: StatusLabel) {
    this.status.set(issue, status);
  }
}

class FakeChecks implements Checks {
  results: CheckResult[] = [];
  runs = 0;
  async run(): Promise<CheckResult> {
    this.runs++;
    return this.results.shift() ?? { passed: true, output: 'all good' };
  }
}

// ─── Scripted model ─────────────────────────────────────────────────────────

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const triage = (decision = 'proceed', questions: string[] = []) =>
  call('report_triage', {
    decision,
    kind: 'feature',
    summary: 'Add a hello file.',
    plan: decision === 'proceed' ? ['Create hello.txt'] : [],
    questions,
  });
const write = (path: string, content: string) => call('write', { path, content });
const done = () => call('report_done', { summary: 'Added hello.txt.', testing: 'Ran the checks.' });
const approve = () => call('report_review', { verdict: 'approve', summary: 'Fine.', findings: [] });
const changes = (findings: string[]) => call('report_review', { verdict: 'changes', summary: 'Needs work.', findings });

/** A response that first checks what the agent just saw: the last message of the request. */
const expectLast = (check: (message: ToolResultMessage | { role: string; content: unknown }) => void, then: FauxResponseStep): FauxResponseFactory =>
  (request, options, state, model) => {
    check(request.messages.at(-1) as ToolResultMessage);
    return typeof then === 'function' ? then(request, options, state, model) : then;
  };
const textOf = (message: { content: unknown }) =>
  typeof message.content === 'string'
    ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');

// ─── Fixture ────────────────────────────────────────────────────────────────

const temp: string[] = [];
after(async () => {
  for (const dir of temp) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'phat-pipeline-'));
  temp.push(dir);
  // A local "GitHub" repository with one commit on main.
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  await run('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), '# test\n');
  const git = (args: string[], cwd = seed) =>
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
  await git(['push', remote, 'main']);

  const config: Config = {
    ...defaultConfig(join(dir, 'home')),
    repo: 'test/repo',
    models: {
      triage: { provider: 'faux', modelId: 'faux-1' },
      implement: { provider: 'faux', modelId: 'faux-1' },
      review: { provider: 'faux', modelId: 'faux-1' },
    },
  };
  const github = new FakeGitHub();
  const checks = new FakeChecks();
  const services: Services = {
    config,
    github,
    checks,
    logger: silentLogger,
    workspaces: new GitWorkspaces({
      remoteUrl: remote,
      baseBranch: 'main',
      cloneDir: paths.repoClone(config),
      workspaceDir: (issue) => paths.workspace(config, issue),
    }),
  };
  // Commits in the workspace need an identity; the real CLI uses the user's git config.
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'phat-mode-test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

  const open = async (responses: FauxResponseStep[]) => {
    const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = () => openNodeSqliteStorage(join(dir, 'state.sqlite'));
    const phat = await openPhatMode(services, context, { storage, models });
    return { phat, faux };
  };

  const runIssue = async (issue: number, responses: FauxResponseStep[]) => {
    const { phat, faux } = await open(responses);
    const { taskId } = await phat.start({ repo: config.repo, issue }, context);
    phat.harness.resume();
    const { outcome } = (await phat.harness.waitForTask(taskId, context)).state;
    await phat.close(context);
    return { outcome, faux };
  };

  const remoteFile = async (issue: number, file: string) =>
    (await run('git', ['--git-dir', remote, 'show', `${branchFor(issue)}:${file}`])).stdout;

  return { config, github, checks, open, runIssue, remoteFile, remote };
}

const result = (outcome: { status: string; result?: PipelineResult }) => {
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  return outcome.result!;
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pipeline', () => {
  test('happy path: triage, implement, verify, review, then a draft pull request', async () => {
    const { github, checks, runIssue, remoteFile } = await fixture();
    github.addIssue(1);
    const { outcome, faux } = await runIssue(1, [triage(), write('hello.txt', 'hello\n'), done(), approve()]);

    assert.deepEqual(result(outcome), { status: 'pr_opened', url: 'https://github.test/pull/1' });
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(checks.runs, 1);
    assert.equal(await remoteFile(1, 'hello.txt'), 'hello\n');
    const [pr] = github.prs;
    assert.equal(github.prs.length, 1);
    assert.equal(pr!.branch, 'phat-mode/issue-1');
    assert.equal(pr!.base, 'main');
    assert.match(pr!.body, /^Closes #1/);
    assert.match(pr!.body, /Approved by the reviewer agent/);
    assert.deepEqual(
      github.comments.map((comment) => comment.marker),
      ['<!-- phat-mode:triage -->', '<!-- phat-mode:result -->'],
    );
    assert.equal(github.status.get(1), 'done');
  });

  test('failing checks go back to the implementer with the output', async () => {
    const { github, checks, runIssue } = await fixture();
    github.addIssue(2);
    checks.results = [{ passed: false, output: 'FAIL hello.test.ts: expected hello' }];
    const { outcome } = await runIssue(2, [
      triage(),
      write('hello.txt', 'helo\n'),
      done(),
      expectLast((message) => assert.match(textOf(message), /FAIL hello\.test\.ts/), write('hello.txt', 'hello\n')),
      done(),
      approve(),
    ]);
    assert.equal(result(outcome).status, 'pr_opened');
    assert.equal(checks.runs, 2);
  });

  test('review findings go back to the implementer, then a second review', async () => {
    const { github, runIssue, remoteFile } = await fixture();
    github.addIssue(3);
    const { outcome } = await runIssue(3, [
      triage(),
      write('hello.txt', 'hello\n'),
      done(),
      changes(['hello.txt: missing trailing exclamation mark']),
      expectLast((message) => assert.match(textOf(message), /missing trailing exclamation/), write('hello.txt', 'hello!\n')),
      done(),
      approve(),
    ]);
    assert.equal(result(outcome).status, 'pr_opened');
    assert.equal(await remoteFile(3, 'hello.txt'), 'hello!\n');
  });

  test('opens the PR with unresolved findings listed after the last review round', async () => {
    const { github, runIssue } = await fixture();
    github.addIssue(4);
    const { outcome } = await runIssue(4, [
      triage(),
      write('hello.txt', 'a\n'),
      done(),
      changes(['first problem']),
      write('hello.txt', 'b\n'),
      done(),
      changes(['still a problem']),
    ]);
    assert.equal(result(outcome).status, 'pr_opened');
    assert.match(github.prs[0]!.body, /Unresolved review findings\n\n- still a problem/);
  });

  test('asks questions on the issue when triage needs more detail', async () => {
    const { github, runIssue } = await fixture();
    github.addIssue(5);
    const { outcome } = await runIssue(5, [triage('needs_info', ['Which screen should change?'])]);
    assert.deepEqual(result(outcome), { status: 'needs_info' });
    assert.match(github.comments[0]!.body, /Which screen should change\?/);
    assert.equal(github.status.get(5), 'needsInfo');
    assert.equal(github.prs.length, 0);
  });

  test('ignores issues from people not in allowedAuthors, without touching GitHub', async () => {
    const { github, runIssue } = await fixture();
    github.addIssue(6, { author: 'stranger' });
    const { outcome, faux } = await runIssue(6, [triage()]);
    assert.equal(result(outcome).status, 'ignored');
    assert.equal(faux.state.callCount, 0);
    assert.equal(github.commentWrites, 0);
    assert.equal(github.status.size, 0);
  });

  test('blocks git push from agents; the pipeline still finishes', async () => {
    const { github, runIssue, remote } = await fixture();
    github.addIssue(7);
    const before = (await run('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout;
    const { outcome } = await runIssue(7, [
      triage(),
      call('bash', { command: 'git push origin HEAD:main --force' }),
      expectLast((message) => {
        assert.equal((message as ToolResultMessage).isError, true);
        assert.match(textOf(message), /Blocked/);
      }, write('hello.txt', 'hello\n')),
      done(),
      approve(),
    ]);
    assert.equal(result(outcome).status, 'pr_opened');
    assert.equal((await run('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout, before);
  });

  test('fails with a comment when checks keep failing', async () => {
    const { github, checks, config, runIssue } = await fixture();
    github.addIssue(8);
    checks.results = Array.from({ length: 10 }, () => ({ passed: false, output: 'still broken' }));
    const responses: FauxResponseStep[] = [triage()];
    for (let i = 0; i <= config.limits.maxCheckFixes; i++) responses.push(write('hello.txt', `${i}\n`), done());
    const { outcome } = await runIssue(8, responses);
    assert.equal(outcome.status, 'failed');
    assert.equal(checks.runs, config.limits.maxCheckFixes + 1);
    assert.match(github.comments.at(-1)!.body, /could not finish/);
    assert.equal(github.status.get(8), 'failed');
    assert.equal(github.prs.length, 0);
  });

  test('survives a crash mid-run: continues where it stopped, without repeating triage or comments', async () => {
    const { github, open, remoteFile, config } = await fixture();
    github.addIssue(9);

    // First process: triage finishes, then the implementer's first request hangs until the process "dies".
    let reachedImplement!: () => void;
    const implementStarted = new Promise<void>((resolve) => (reachedImplement = resolve));
    const hang: FauxResponseFactory = (_request, options) =>
      new Promise((_resolve, reject) => {
        reachedImplement();
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const first = await open([triage(), hang]);
    const { taskId } = await first.phat.start({ repo: config.repo, issue: 9 }, context);
    first.phat.harness.resume();
    await implementStarted;
    await first.phat.close(context);
    assert.equal(github.comments.length, 1, 'triage comment posted before the crash');

    // Second process: same storage. Only the implementer and reviewer answer; triage must not run again.
    const second = await open([write('hello.txt', 'hello\n'), done(), approve()]);
    const again = await second.phat.start({ repo: config.repo, issue: 9 }, context);
    assert.equal(again.taskId, taskId);
    assert.equal(again.resumed, true);
    second.phat.harness.resume();
    const { outcome } = (await second.phat.harness.waitForTask(taskId, context)).state;
    await second.phat.close(context);

    assert.equal(result(outcome as { status: string; result?: PipelineResult }).status, 'pr_opened');
    assert.equal(second.faux.getPendingResponseCount(), 0);
    assert.equal(github.comments.filter((comment) => comment.marker.includes('triage')).length, 1);
    assert.equal(github.prs.length, 1);
    assert.equal(await remoteFile(9, 'hello.txt'), 'hello\n');
  });

  test('only one process can open the state: a second open is refused until the first closes', async () => {
    const { open } = await fixture();
    const first = await open([]);
    await assert.rejects(open([]), LockedError);
    await first.phat.close(context);
    const second = await open([]);
    await second.phat.close(context);
  });
});
