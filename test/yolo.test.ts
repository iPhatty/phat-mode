import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CheckState } from '../src/github.ts';
import type { RepairResult } from '../src/repair.ts';
import { baseRedMarker, rerunMarker } from '../src/stuck.ts';
import { runOrWait, waitToMerge, yoloMarker, yoloMerge, type YoloVerdict } from '../src/yolo.ts';
import { FakeGitHub } from './fakes.ts';

process.env.TZ = 'UTC';

const NOW = new Date('2026-10-31T12:00:00Z');
const SHA = 'abc123';

/** phat-mode's open pull request for issue 7, with the verdict it wrote, its head commit and the checks on it. */
function pullRequest(
  options: {
    verdict?: YoloVerdict | null;
    head?: string;
    committedAt?: string;
    checks?: [string, CheckState][];
  } = {},
) {
  const github = new FakeGitHub();
  const pr: FakeGitHub['prs'][number] = github.addPullRequest({ branch: 'phat-mode/issue-7' });
  const verdict = options.verdict === undefined ? { verdict: 'clean' as const, sha: SHA } : options.verdict;
  pr.body = `## Summary\n\nAdds hello.${verdict === null ? '' : `\n\n${yoloMarker(verdict)}`}`;
  github.statuses.set(pr.number, {
    head: { sha: options.head ?? SHA, committedAt: options.committedAt ?? '2026-10-31T11:50:00Z' },
    checks: (options.checks ?? [['test', 'passed']]).map(([name, state]) => ({ name, state })),
  });
  const merge = () => yoloMerge(github, { number: pr.number, url: pr.url, issue: 7 }, { command: 'watch', now: NOW });
  return { github, pr, merge };
}

describe('yolo merge', () => {
  test('clean, unchanged, every check passed and settled: squash-merged at exactly that commit, with a comment', async () => {
    const { github, pr, merge } = pullRequest({ checks: [['test', 'passed'], ['lint', 'passed'], ['docs', 'passed']] });
    assert.deepEqual(await merge(), { merged: true });
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: SHA }]);
    assert.deepEqual(github.prComments, [
      { pr: pr.number, body: 'Merged by `phat-mode watch --yolo`: phat-mode found it clean, and all 3 checks passed.' },
    ]);
  });

  test('no verdict from phat-mode, e.g. opened by an older version: yours, never merged', async () => {
    const { github, merge } = pullRequest({ verdict: null });
    assert.deepEqual(await merge(), { merged: false, needsYou: true, reason: 'phat-mode left no verdict on it' });
    assert.equal(github.writes, 0);
  });

  test('phat-mode found it not clean: yours, with phat-mode’s reason, even with every check green', async () => {
    const { github, merge } = pullRequest({ verdict: { verdict: 'not-clean', sha: SHA, reason: 'code review has open findings' } });
    assert.deepEqual(await merge(), { merged: false, needsYou: true, reason: 'code review has open findings' });
    assert.equal(github.writes, 0);
  });

  test('commits added after phat-mode: yours, as nobody reviewed or verified them', async () => {
    const { github, merge } = pullRequest({ head: 'def456' });
    assert.deepEqual(await merge(), { merged: false, needsYou: true, reason: 'commits added after phat-mode' });
    assert.equal(github.writes, 0);
  });

  test('a check failed: yours, naming the failed checks, even while others still run', async () => {
    const { github, merge } = pullRequest({ checks: [['test', 'passed'], ['e2e', 'failed'], ['build', 'running'], ['lint', 'failed']] });
    assert.deepEqual(await merge(), { merged: false, needsYou: true, reason: 'checks failed: e2e, lint' });
    assert.equal(github.writes, 0);
  });

  test('checks still running: not yet, it merges on a later look', async () => {
    const { github, merge } = pullRequest({ checks: [['test', 'passed'], ['build', 'running'], ['e2e', 'running']] });
    assert.deepEqual(await merge(), { merged: false, needsYou: false, reason: 'checks running: build, e2e' });
    assert.equal(github.writes, 0);
  });

  test('pushed under a minute ago: not yet, even all green, so late checks can still show up', async () => {
    const { github, merge } = pullRequest({ committedAt: '2026-10-31T12:00:00Z' });
    assert.deepEqual(await merge(), {
      merged: false,
      needsYou: false,
      reason: 'settling (merges after 12:01)',
      settlesAt: new Date('2026-10-31T12:01:00Z'),
    });
    assert.equal(github.writes, 0);
  });

  test('no checks at all: merged once settled, as phat-mode’s own checks, review and verification passed', async () => {
    const { github, merge } = pullRequest({ checks: [] });
    assert.deepEqual(await merge(), { merged: true });
    assert.deepEqual(github.prComments.map((comment) => comment.body), [
      'Merged by `phat-mode watch --yolo`: phat-mode found it clean, and there are no checks on it.',
    ]);
  });

  test('one check: the comment says so', async () => {
    const { github, merge } = pullRequest({ checks: [['test', 'passed']] });
    await merge();
    assert.deepEqual(github.prComments.map((comment) => comment.body), [
      'Merged by `phat-mode watch --yolo`: phat-mode found it clean, and its 1 check passed.',
    ]);
  });

  test('GitHub refuses (review required, conflicts, squash not allowed): yours, with GitHub’s reason', async () => {
    const { github, pr, merge } = pullRequest();
    github.refuseMerge.set(pr.number, 'At least 1 approving review is required by reviewers with write access.\nMore detail.');
    assert.deepEqual(await merge(), {
      merged: false,
      needsYou: true,
      reason: 'GitHub refused: At least 1 approving review is required by reviewers with write access.',
    });
    assert.deepEqual(github.prComments, []);
  });
});

describe('run --yolo: waiting to merge', () => {
  /** A clock that sleeping moves on; `onSleep` changes GitHub meanwhile. */
  function clock(onSleep: (slept: number) => void = () => {}) {
    let now = NOW.getTime();
    const sleeps: number[] = [];
    return {
      now: () => new Date(now),
      sleep: async (ms: number) => {
        now += ms;
        sleeps.push(ms);
        onSleep(sleeps.length);
      },
      slept: () => sleeps.length,
      sleeps,
    };
  }

  test('keeps looking while checks run and the commit settles, saying each reason once, then merges', async () => {
    const { github, pr } = pullRequest({ committedAt: '2026-10-31T11:59:45Z', checks: [['build', 'running']] });
    const time = clock((slept) => {
      if (slept === 1) github.statuses.get(pr.number)!.checks = [{ name: 'build', state: 'passed' }];
    });
    const said: string[] = [];
    const outcome = await waitToMerge(github, 7, { ...time, intervalMs: 30_000, say: (text) => said.push(text) });
    assert.deepEqual(outcome, { merged: true, url: pr.url });
    // 12:00:00 running, 12:00:30 settling until 12:00:45, 12:00:46 merged.
    assert.deepEqual(time.sleeps, [30_000, 16_000]);
    assert.deepEqual(said, ['checks running: build', 'settling (merges after 12:00)']);
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: SHA }]);
    assert.match(github.prComments[0]!.body, /^Merged by `phat-mode run --yolo`/);
  });

  test('only settling left: looks again as soon as it has settled, not a whole interval later', async () => {
    const { github, pr } = pullRequest({ committedAt: '2026-10-31T12:00:00Z' });
    const time = clock();
    const outcome = await waitToMerge(github, 7, { ...time, intervalMs: 2 * 60_000, say: () => {} });
    assert.deepEqual(outcome, { merged: true, url: pr.url });
    assert.deepEqual(time.sleeps, [61_000]);
  });

  test('stops as soon as only you can move it on, e.g. a check fails meanwhile', async () => {
    const { github, pr } = pullRequest({ checks: [['build', 'running']] });
    const time = clock(() => (github.statuses.get(pr.number)!.checks = [{ name: 'build', state: 'failed' }]));
    const said: string[] = [];
    const outcome = await waitToMerge(github, 7, { ...time, intervalMs: 60_000, say: (text) => said.push(text) });
    assert.deepEqual(outcome, { merged: false, reason: 'checks failed: build', url: pr.url });
    assert.equal(time.slept(), 1);
    assert.deepEqual(github.merges, []);
  });

  test('no open pull request for the issue: nothing to wait for', async () => {
    const github = new FakeGitHub();
    const outcome = await waitToMerge(github, 7, { ...clock(), intervalMs: 60_000, say: () => {} });
    assert.deepEqual(outcome, { merged: false, reason: 'no open pull request' });
  });

});

describe('run --yolo: repairing while it waits to merge', () => {
  const REPAIRED = 'fed987';

  /** A clock that sleeping moves on. */
  function clock() {
    let now = NOW.getTime();
    const sleeps: number[] = [];
    return {
      now: () => new Date(now),
      sleep: async (ms: number) => {
        now += ms;
        sleeps.push(ms);
      },
      sleeps,
    };
  }

  /** What a published repair leaves on GitHub: a new head, phat-mode's clean verdict for it, no conflicts. */
  function publishRepair(github: FakeGitHub, pr: { number: number; body: string }, checks: [string, CheckState][] = [['test', 'passed']]) {
    pr.body = `## Summary\n\nAdds hello, repaired.\n\n${yoloMarker({ verdict: 'clean', sha: REPAIRED })}`;
    github.statuses.set(pr.number, {
      head: { sha: REPAIRED, committedAt: '2026-10-31T11:55:00Z' },
      checks: checks.map(([name, state]) => ({ name, state })),
    });
  }

  test('a pull request that conflicts: repaired once, then merged at the repaired head', async () => {
    const { github, pr } = pullRequest();
    github.statuses.get(pr.number)!.mergeable = 'CONFLICTING';
    let repairs = 0;
    const said: string[] = [];
    const outcome = await waitToMerge(github, 7, {
      ...clock(),
      intervalMs: 60_000,
      say: (text) => said.push(text),
      repair: {
        maxRepairs: 3,
        baseBranch: 'main',
        run: async () => {
          repairs++;
          publishRepair(github, pr);
          return { status: 'repaired', url: pr.url };
        },
      },
    });
    assert.deepEqual(outcome, { merged: true, url: pr.url });
    assert.equal(repairs, 1);
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: REPAIRED }]);
    assert.equal(said[0], 'repairing: conflicts with main');
  });

  /** waitToMerge with a repair callback; `run` stands in for the Repair task. */
  function waitWithRepair(
    github: FakeGitHub,
    run: () => Promise<RepairResult>,
    time: ReturnType<typeof clock> = clock(),
  ) {
    const said: string[] = [];
    let repairs = 0;
    const outcome = waitToMerge(github, 7, {
      ...time,
      intervalMs: 60_000,
      say: (text) => said.push(text),
      repair: {
        maxRepairs: 3,
        baseBranch: 'main',
        run: () => {
          repairs++;
          return run();
        },
      },
    });
    return { outcome, said, repairs: () => repairs };
  }

  const never = async (): Promise<RepairResult> => assert.fail('repair must not run');

  test('failed checks: repair reruns the failed jobs, the wait goes on, and it merges once they pass', async () => {
    const { github, pr } = pullRequest({ checks: [['test', 'failed']] });
    const time = clock();
    const wait = waitWithRepair(
      github,
      async () => {
        await github.upsertComment(pr.number, rerunMarker(SHA), 'Reran the failed jobs.');
        github.statuses.get(pr.number)!.checks = [{ name: 'test', state: 'running' }];
        return { status: 'waiting', url: pr.url, reason: 'reran the failed jobs of test' };
      },
      { ...time, sleep: async (ms) => {
        await time.sleep(ms);
        github.statuses.get(pr.number)!.checks = [{ name: 'test', state: 'passed' }];
      } },
    );
    assert.deepEqual(await wait.outcome, { merged: true, url: pr.url });
    assert.equal(wait.repairs(), 1);
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: SHA }]);
    assert.deepEqual(wait.said, ['repairing: checks failed: test', 'waiting: reran the failed jobs of test', 'checks running: test']);
  });

  test('the repair gives up: stops with its reason', async () => {
    const { github, pr } = pullRequest();
    github.statuses.get(pr.number)!.mergeable = 'CONFLICTING';
    const wait = waitWithRepair(github, async () => ({ status: 'stuck', url: pr.url, reason: 'gave up: 3 repairs spent' }));
    assert.deepEqual(await wait.outcome, { merged: false, reason: 'gave up: 3 repairs spent', url: pr.url });
    assert.deepEqual(github.merges, []);
  });

  test('labelled phat-mode:stuck: stops with the reason, no repair', async () => {
    const { github, pr } = pullRequest({ checks: [['test', 'failed']] });
    pr.labels.push('phat-mode:stuck');
    const wait = waitWithRepair(github, never);
    assert.deepEqual(await wait.outcome, { merged: false, reason: 'phat-mode:stuck: waiting for you', url: pr.url });
  });

  test('changes requested after phat-mode pushed: paused, stops with the reason, no repair', async () => {
    const { github, pr } = pullRequest();
    const status = github.statuses.get(pr.number)!;
    status.mergeable = 'CONFLICTING';
    status.reviews = [{ author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-31T11:55:00Z' }];
    const wait = waitWithRepair(github, never);
    assert.deepEqual(await wait.outcome, { merged: false, reason: 'repair paused: changes requested by @bob', url: pr.url });
  });

  test('commits added after phat-mode: stops with the reason, no repair', async () => {
    const { github, pr } = pullRequest({ head: 'def456', checks: [['test', 'failed']] });
    const wait = waitWithRepair(github, never);
    assert.deepEqual(await wait.outcome, { merged: false, reason: 'commits added after phat-mode', url: pr.url });
  });

  test('no verdict from phat-mode: stops with the reason, no repair', async () => {
    const { github, pr } = pullRequest({ verdict: null, checks: [['test', 'failed']] });
    const wait = waitWithRepair(github, never);
    assert.deepEqual(await wait.outcome, { merged: false, reason: 'phat-mode left no verdict on it', url: pr.url });
  });

  test('failed checks that fail on the base branch too: keeps waiting, says why once, spends no repair', async () => {
    const { github, pr } = pullRequest({ checks: [['test', 'failed']] });
    github.commits.set('main', { sha: 'ba5e01', checks: [] });
    await github.upsertComment(pr.number, rerunMarker(SHA), 'Reran the failed jobs.');
    await github.upsertComment(pr.number, baseRedMarker({ head: SHA, base: 'ba5e01', cause: 'base-red' }), 'Fails on main too.');
    const time = clock();
    let looks = 0;
    const wait = waitWithRepair(github, never, {
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        // Someone fixes the check meanwhile, e.g. a rerun by hand once main is green.
        if (++looks === 3) github.statuses.get(pr.number)!.checks = [{ name: 'test', state: 'passed' }];
      },
    });
    assert.deepEqual(await wait.outcome, { merged: true, url: pr.url });
    assert.deepEqual(wait.said, ['test fails on main too']);
    assert.deepEqual(time.sleeps, [60_000, 60_000, 60_000]);
  });

  test('a check fails between the look and the merge: repaired, not handed to you', async () => {
    const { github, pr } = pullRequest();
    // GitHub's answer changes right after the first look: the merge sees the failure, which repair handles.
    const read = github.pullRequestStatus.bind(github);
    let reads = 0;
    github.pullRequestStatus = async (number) => {
      const status = await read(number);
      if (++reads === 1) github.statuses.get(pr.number)!.checks = [{ name: 'test', state: 'failed' }];
      return status;
    };
    const wait = waitWithRepair(github, async () => {
      publishRepair(github, pr);
      return { status: 'repaired', url: pr.url };
    });
    assert.deepEqual(await wait.outcome, { merged: true, url: pr.url });
    assert.equal(wait.repairs(), 1);
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: REPAIRED }]);
  });

  test('GitHub refuses because the base branch moved on meanwhile: repaired, then merged', async () => {
    const { github, pr } = pullRequest();
    github.mergePullRequest = async (number) => {
      // main moved on just now, and GitHub requires the branch up to date.
      github.statuses.get(number)!.mergeState = 'BEHIND';
      throw new Error('gh pr merge exited with 1: the head branch is not up to date with the base branch');
    };
    const merge = FakeGitHub.prototype.mergePullRequest.bind(github);
    const wait = waitWithRepair(github, async () => {
      publishRepair(github, pr);
      github.mergePullRequest = merge;
      return { status: 'repaired', url: pr.url };
    });
    assert.deepEqual(await wait.outcome, { merged: true, url: pr.url });
    assert.equal(wait.repairs(), 1);
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: REPAIRED }]);
  });

  test('nothing stuck, but GitHub refuses the merge: stops with GitHub’s reason', async () => {
    const { github, pr } = pullRequest();
    github.refuseMerge.set(pr.number, 'At least 1 approving review is required by reviewers with write access.');
    const wait = waitWithRepair(github, never);
    assert.deepEqual(await wait.outcome, {
      merged: false,
      reason: 'GitHub refused: At least 1 approving review is required by reviewers with write access.',
      url: pr.url,
    });
  });
});

describe('run: what it does first', () => {
  const repair = { maxRepairs: 3, baseBranch: 'main', now: NOW };

  test('a run is going: it is resumed first, even with its pull request open (e.g. a repair stopped by Ctrl-C)', async () => {
    const { github, pr } = pullRequest();
    github.statuses.get(pr.number)!.mergeable = 'CONFLICTING';
    assert.deepEqual(await runOrWait(github, 7, { runGoing: true, yolo: false, repair }), { kind: 'run' });
    assert.deepEqual(await runOrWait(github, 7, { runGoing: true, yolo: true, repair }), { kind: 'run' });
  });

  test('no pull request yet: run', async () => {
    assert.deepEqual(await runOrWait(new FakeGitHub(), 7, { runGoing: false, yolo: false, repair }), { kind: 'run' });
    assert.deepEqual(await runOrWait(new FakeGitHub(), 7, { runGoing: false, yolo: true }), { kind: 'run' });
  });

  test('--yolo with the pull request already open and no run going: straight to the wait, no new run', async () => {
    const { github } = pullRequest();
    assert.deepEqual(await runOrWait(github, 7, { runGoing: false, yolo: true }), { kind: 'wait' });
    assert.deepEqual(await runOrWait(github, 7, { runGoing: false, yolo: true, repair }), { kind: 'wait' });
  });

  test('repair off, pull request open: a new run, as before', async () => {
    const { github, pr } = pullRequest();
    github.statuses.get(pr.number)!.mergeable = 'CONFLICTING';
    assert.deepEqual(await runOrWait(github, 7, { runGoing: false, yolo: false }), { kind: 'run' });
  });

  test('a pull request that conflicts with its base: repair it', async () => {
    const { github, pr } = pullRequest();
    github.statuses.get(pr.number)!.mergeable = 'CONFLICTING';
    assert.deepEqual(await runOrWait(github, 7, { runGoing: false, yolo: false, repair }), {
      kind: 'repair',
      url: pr.url,
      reason: 'conflicts with main',
    });
  });

  test('a pull request repair leaves alone: says why, and it needs you', async () => {
    const paused = pullRequest({ checks: [['test', 'failed']] });
    paused.github.statuses.get(paused.pr.number)!.reviews = [
      { author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-31T11:55:00Z' },
    ];
    assert.deepEqual(await runOrWait(paused.github, 7, { runGoing: false, yolo: false, repair }), {
      kind: 'open',
      url: paused.pr.url,
      reason: 'repair paused: changes requested by @bob',
      needsYou: true,
    });
    const stuck = pullRequest({ checks: [['test', 'failed']] });
    stuck.pr.labels.push('phat-mode:stuck');
    assert.deepEqual(await runOrWait(stuck.github, 7, { runGoing: false, yolo: false, repair }), {
      kind: 'open',
      url: stuck.pr.url,
      reason: 'phat-mode:stuck: waiting for you',
      needsYou: true,
    });
  });

  test('a clean, green pull request: nothing to repair, it waits for you to merge it', async () => {
    const { github, pr } = pullRequest();
    assert.deepEqual(await runOrWait(github, 7, { runGoing: false, yolo: false, repair }), {
      kind: 'open',
      url: pr.url,
      reason: 'not stuck',
      needsYou: false,
    });
    assert.equal(github.writes, 0);
  });
});
