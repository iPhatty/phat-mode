import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CheckState } from '../src/github.ts';
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
  const pr = github.addPullRequest({ branch: 'phat-mode/issue-7' });
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

  test('the pull request is already open and no run is going: straight to the wait, no new run', async () => {
    const { github } = pullRequest();
    assert.equal(await runOrWait(github, 7, { runGoing: false }), 'wait');
  });

  test('a run is going: it is resumed first, even with its pull request open', async () => {
    const { github } = pullRequest();
    assert.equal(await runOrWait(github, 7, { runGoing: true }), 'run');
  });

  test('no pull request yet: run', async () => {
    assert.equal(await runOrWait(new FakeGitHub(), 7, { runGoing: false }), 'run');
  });
});
