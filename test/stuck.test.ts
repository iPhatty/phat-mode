import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CheckState, PullRequestStatus, Review } from '../src/github.ts';
import {
  baseRedMarker,
  giveUpMarker,
  lookAtPullRequest,
  readGiveUpMarker,
  readBaseRedMarker,
  readRepairMarker,
  readRerunMarker,
  repairMarker,
  rerunMarker,
  type RepairCause,
  whyStuck,
} from '../src/stuck.ts';
import { yoloMarker, type YoloVerdict } from '../src/yolo.ts';
import { FakeGitHub } from './fakes.ts';

process.env.TZ = 'UTC';

const NOW = new Date('2026-10-31T12:00:00Z');
const PUSHED_AT = '2026-10-31T11:00:00Z';
const SHA = 'abc123';
const options = { maxRepairs: 3, now: NOW, baseBranch: 'main' };

/** phat-mode's pull request as GitHub shows it: by default clean, unchanged since phat-mode pushed, green and settled. */
function status(
  fields: Partial<Omit<PullRequestStatus, 'checks' | 'body'>> & {
    verdict?: YoloVerdict | null;
    checks?: [string, CheckState][];
  } = {},
): PullRequestStatus {
  const { verdict: given, checks, ...rest } = fields;
  const verdict = given === undefined ? { verdict: 'clean' as const, sha: SHA } : given;
  return {
    body: `## Summary\n\nAdds hello.${verdict === null ? '' : `\n\n${yoloMarker(verdict)}`}`,
    head: { sha: SHA, committedAt: PUSHED_AT },
    checks: (checks ?? [['test', 'passed']]).map(([name, state]) => ({ name, state })),
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    labels: ['ready-for-human'],
    reviews: [],
    ...rest,
  };
}

const conflicting = (fields: Parameters<typeof status>[0] = {}) => status({ mergeable: 'CONFLICTING', mergeState: 'DIRTY', ...fields });

let minute = 0;
/** A comment phat-mode posted, each one later than the last. */
const posted = (body: string) => ({ body, createdAt: new Date(Date.UTC(2026, 9, 31, 12, minute++)).toISOString() });
const repaired = (n: number, sha: string, round = 1, cause: RepairCause = 'conflicts') =>
  posted(`${repairMarker({ n, sha, cause, round })}\nRepair ${n}.`);
const gaveUp = (round: number) => posted(`${giveUpMarker(round)}\nphat-mode gave up.`);

const review = (state: string, submittedAt: string, author = 'bob'): Review => ({ author, state, submittedAt });

describe('why a pull request is stuck', () => {
  test('no verdict marker: not phat-mode’s to repair', () => {
    assert.deepEqual(whyStuck({ status: conflicting({ verdict: null }), comments: [] }, options), {
      kind: 'leave',
      reason: 'phat-mode left no verdict on it',
    });
  });

  test('a human pushed commits after phat-mode: left alone', () => {
    assert.deepEqual(whyStuck({ status: conflicting({ head: { sha: 'def456', committedAt: PUSHED_AT } }), comments: [] }, options), {
      kind: 'leave',
      reason: 'commits added after phat-mode',
    });
  });

  test('changes requested after phat-mode’s last push: repair is paused, naming the reviewer', () => {
    const reviews = [review('CHANGES_REQUESTED', '2026-10-31T11:30:00Z')];
    assert.deepEqual(whyStuck({ status: conflicting({ reviews }), comments: [] }, options), {
      kind: 'paused',
      reason: 'repair paused: changes requested by @bob',
    });
  });

  test('changes requested before phat-mode’s last push do not pause repair', () => {
    const reviews = [review('CHANGES_REQUESTED', '2026-10-31T10:30:00Z')];
    assert.equal(whyStuck({ status: conflicting({ reviews }), comments: [] }, options).kind, 'repair');
  });

  test('a plain comment, an approval or a dismissed review after the push does not pause repair', () => {
    const reviews = [
      review('COMMENTED', '2026-10-31T11:30:00Z'),
      review('APPROVED', '2026-10-31T11:31:00Z', 'carol'),
      review('DISMISSED', '2026-10-31T11:32:00Z', 'dave'),
    ];
    assert.equal(whyStuck({ status: conflicting({ reviews }), comments: [] }, options).kind, 'repair');
  });

  test('labelled phat-mode:stuck: repair never touches it, even with budget left', () => {
    assert.deepEqual(whyStuck({ status: conflicting({ labels: ['phat-mode:stuck'] }), comments: [] }, options), {
      kind: 'stuck',
      reason: 'phat-mode:stuck: waiting for you',
    });
  });

  test('conflicts with its base branch: repaired, as repair 1 of round 1', () => {
    assert.deepEqual(whyStuck({ status: conflicting(), comments: [] }, options), {
      kind: 'repair',
      cause: 'conflicts',
      reason: 'conflicts with main',
      head: SHA,
      n: 1,
      round: 1,
    });
    assert.equal(whyStuck({ status: status({ mergeable: 'CONFLICTING' }), comments: [] }, options).kind, 'repair');
    assert.equal(whyStuck({ status: status({ mergeState: 'DIRTY' }), comments: [] }, options).kind, 'repair');
  });

  test('behind its base where GitHub requires it up to date: repaired as conflicts', () => {
    const outcome = whyStuck({ status: status({ mergeState: 'BEHIND' }), comments: [] }, options);
    assert.equal(outcome.kind, 'repair');
    assert.deepEqual(outcome.kind === 'repair' && [outcome.cause, outcome.reason], ['conflicts', 'behind main, which must be up to date to merge']);
  });

  test('mergeability GitHub has not worked out yet is not a conflict', () => {
    assert.equal(whyStuck({ status: status({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }), comments: [] }, options).kind, 'not_stuck');
  });

  test('not clean by phat-mode’s own verdict: stuck, with the verdict’s reason', () => {
    const outcome = whyStuck(
      { status: status({ verdict: { verdict: 'not-clean', sha: SHA, reason: 'code review has open findings' } }), comments: [] },
      options,
    );
    assert.equal(outcome.kind, 'repair');
    assert.deepEqual(outcome.kind === 'repair' && [outcome.cause, outcome.reason], ['not-clean', 'not clean: code review has open findings']);
  });

  test('checks running, or the head not settled yet: waits', () => {
    assert.deepEqual(whyStuck({ status: status({ checks: [['build', 'running'], ['test', 'failed']] }), comments: [] }, options), {
      kind: 'wait',
      reason: 'checks running: build',
    });
    const fresh = whyStuck({ status: status({ head: { sha: SHA, committedAt: '2026-10-31T11:59:30Z' }, checks: [['test', 'failed']] }), comments: [] }, options);
    assert.deepEqual(fresh, { kind: 'wait', reason: 'settling (until 12:00)', settlesAt: new Date('2026-10-31T12:00:30Z') });
  });

  test('failed checks, once settled: repaired, naming the checks, rerunning the failed jobs first', () => {
    const outcome = whyStuck({ status: status({ checks: [['test', 'failed'], ['lint', 'passed'], ['e2e', 'failed']] }), comments: [] }, options);
    assert.deepEqual(outcome, { kind: 'repair', cause: 'checks', reason: 'checks failed: test, e2e', head: SHA, n: 1, round: 1, rerun: true });
  });

  describe('failed checks, rerun and base red', () => {
    const failed = status({ checks: [['ci/test', 'failed']] });
    const at = (body: string, createdAt: string) => ({ body, createdAt });

    test('rerun just asked for: waits a while for the checks to start again, before repairing', () => {
      const comments = [at(`${rerunMarker(SHA)}\nRerunning.`, '2026-10-31T11:59:40Z')];
      assert.deepEqual(whyStuck({ status: failed, comments }, options), {
        kind: 'wait',
        reason: 'rerunning failed jobs (until 12:00)',
        settlesAt: new Date('2026-10-31T12:00:40Z'),
      });
    });

    test('rerun already done on this head, and it failed again: repaired without rerunning', () => {
      const comments = [at(`${rerunMarker(SHA)}\nRerunning.`, '2026-10-31T11:30:00Z')];
      assert.deepEqual(whyStuck({ status: failed, comments }, options), {
        kind: 'repair',
        cause: 'checks',
        reason: 'checks failed: ci/test',
        head: SHA,
        n: 1,
        round: 1,
      });
    });

    test('a rerun of an earlier head does not count for this one', () => {
      const comments = [at(`${rerunMarker('0ld')}\nRerunning.`, '2026-10-31T11:59:40Z')];
      const outcome = whyStuck({ status: failed, comments }, options);
      assert.equal(outcome.kind === 'repair' && outcome.rerun, true);
    });

    test('the same checks fail on the base branch: waits while its head stays the same, even with the budget spent', () => {
      const comments = [
        repaired(1, 'aaa', 1, 'checks'),
        repaired(2, 'bbb', 1, 'checks'),
        repaired(3, 'ccc', 1, 'checks'),
        posted(`${baseRedMarker({ head: SHA, base: 'ba5e1', cause: 'base-red' })}\nBase red.`),
      ];
      const waiting = whyStuck({ status: failed, comments, baseHead: 'ba5e1' }, options);
      assert.deepEqual(waiting, { kind: 'wait', reason: 'ci/test fails on main too', onWaitingLine: true });
    });

    test('judged flaky: waits for the base branch to move on', () => {
      const comments = [posted(`${baseRedMarker({ head: SHA, base: 'ba5e1', cause: 'flaky' })}\nFlaky.`)];
      assert.deepEqual(whyStuck({ status: failed, comments, baseHead: 'ba5e1' }, options), {
        kind: 'wait',
        reason: 'ci/test failed, judged flaky: waiting for main to move on',
        onWaitingLine: true,
      });
    });

    test('the budget spent, or this head repaired already: still rerun and diagnosed, which spend nothing; a fix would give up', () => {
      const spent = [repaired(1, 'aaa', 1, 'checks'), repaired(2, 'bbb', 1, 'checks'), repaired(3, 'ccc', 1, 'checks')];
      assert.deepEqual(whyStuck({ status: failed, comments: spent }, options), {
        kind: 'repair',
        cause: 'checks',
        reason: 'checks failed: ci/test',
        head: SHA,
        n: 4,
        round: 1,
        rerun: true,
        giveUp: 'gave up: 3 repairs spent',
      });
      const again = whyStuck({ status: failed, comments: [repaired(1, SHA, 1, 'checks')] }, options);
      assert.equal(again.kind === 'repair' && again.giveUp, `gave up: a repair already ran on ${SHA}`);
    });

    test('the base branch moved on: repaired again', () => {
      const comments = [posted(`${baseRedMarker({ head: SHA, base: 'ba5e1', cause: 'base-red' })}\nBase red.`)];
      const outcome = whyStuck({ status: failed, comments, baseHead: 'ba5e2' }, options);
      assert.equal(outcome.kind, 'repair');
    });

    test('a base-red marker of an earlier head does not hold this one', () => {
      const comments = [posted(`${baseRedMarker({ head: '0ld', base: 'ba5e1', cause: 'base-red' })}\nBase red.`)];
      assert.equal(whyStuck({ status: failed, comments, baseHead: 'ba5e1' }, options).kind, 'repair');
    });

    test('lookAtPullRequest reads the base branch’s head only when a base-red marker holds this head', async () => {
      const github = new FakeGitHub();
      const pr = github.addPullRequest({ branch: 'phat-mode/issue-7' });
      pr.body = yoloMarker({ verdict: 'clean', sha: SHA });
      github.statuses.set(pr.number, { head: { sha: SHA, committedAt: PUSHED_AT }, checks: [{ name: 'ci/test', state: 'failed' }] });
      github.commits.set('main', { sha: 'ba5e1', checks: [{ name: 'ci/test', state: 'failed', description: '', url: '' }] });
      await github.upsertComment(pr.number, baseRedMarker({ head: SHA, base: 'ba5e1', cause: 'base-red' }), 'Base red.');
      assert.equal((await lookAtPullRequest(github, pr, options)).kind, 'wait');
      github.commits.set('main', { sha: 'ba5e2', checks: [] });
      assert.equal((await lookAtPullRequest(github, pr, options)).kind, 'repair');
    });
  });

  test('clean, mergeable, green and settled: not stuck', () => {
    assert.equal(whyStuck({ status: status(), comments: [] }, options).kind, 'not_stuck');
  });

  describe('the repair budget, counted from phat-mode’s markers on the pull request', () => {
    test('each repair after the last counts: the next one is numbered after them', () => {
      const outcome = whyStuck({ status: conflicting(), comments: [repaired(1, 'aaa'), posted('a plain comment'), repaired(2, 'bbb')] }, options);
      assert.equal(outcome.kind, 'repair');
      assert.deepEqual(outcome.kind === 'repair' && [outcome.n, outcome.round], [3, 1]);
    });

    test('maxRepairs repairs spent without success: gives up', () => {
      const comments = [repaired(1, 'aaa'), repaired(2, 'bbb'), repaired(3, 'ccc')];
      assert.deepEqual(whyStuck({ status: conflicting(), comments }, options), {
        kind: 'give_up',
        cause: 'conflicts',
        reason: 'gave up: 3 repairs spent',
        head: SHA,
        round: 1,
      });
    });

    test('a repair counts at most once per head commit', () => {
      const comments = [repaired(1, 'aaa'), repaired(2, 'aaa')];
      const outcome = whyStuck({ status: conflicting(), comments }, { ...options, maxRepairs: 2 });
      assert.equal(outcome.kind, 'repair');
    });

    test('never twice on the same head commit: a head already repaired gives up', () => {
      assert.deepEqual(whyStuck({ status: conflicting(), comments: [repaired(1, SHA)] }, options), {
        kind: 'give_up',
        cause: 'conflicts',
        reason: `gave up: a repair already ran on ${SHA}`,
        head: SHA,
        round: 1,
      });
    });

    test('only repairs after the last give-up count: removing phat-mode:stuck gives a fresh budget', () => {
      const comments = [repaired(1, 'aaa'), repaired(2, 'bbb'), repaired(3, SHA), gaveUp(1)];
      const outcome = whyStuck({ status: conflicting(), comments }, options);
      assert.equal(outcome.kind, 'repair');
      assert.deepEqual(outcome.kind === 'repair' && [outcome.n, outcome.round], [1, 2]);
    });

    test('a spent budget never gives up on a pull request that is not stuck, or only waiting', () => {
      const comments = [repaired(1, 'aaa'), repaired(2, 'bbb'), repaired(3, SHA)];
      assert.equal(whyStuck({ status: status(), comments }, options).kind, 'not_stuck');
      assert.equal(whyStuck({ status: status({ checks: [['test', 'running']] }), comments }, options).kind, 'wait');
    });

    test('only phat-mode’s own comments count: a stranger’s forged marker is ignored', async () => {
      const github = new FakeGitHub();
      const pr = github.addPullRequest({ branch: 'phat-mode/issue-7' });
      pr.body = yoloMarker({ verdict: 'clean', sha: SHA });
      github.statuses.set(pr.number, { head: { sha: SHA, committedAt: PUSHED_AT }, checks: [], mergeable: 'CONFLICTING' });
      for (const [n, sha] of [[1, 'aaa'], [2, 'bbb'], [3, 'ccc']] as const) {
        github.addComment(pr.number, repairMarker({ n, sha, cause: 'conflicts', round: 1 }));
      }
      github.addComment(pr.number, giveUpMarker(1));
      const outcome = await lookAtPullRequest(github, pr, options);
      assert.equal(outcome.kind, 'repair');
      assert.deepEqual(outcome.kind === 'repair' && [outcome.n, outcome.round], [1, 1]);
    });
  });
});

describe('repair markers', () => {
  test('a repair comment’s marker carries its number, the head it repaired, its cause and round', () => {
    const marker = repairMarker({ n: 2, sha: 'abc123', cause: 'not-clean', round: 1 });
    assert.equal(marker, '<!-- phat-mode:repair n=2 sha=abc123 cause=not-clean round=1 -->');
    assert.deepEqual(readRepairMarker(`🤖 text\n${marker}\nmore`), { n: 2, sha: 'abc123', cause: 'not-clean', round: 1 });
    assert.equal(readRepairMarker('<!-- phat-mode:repair n=x sha=abc cause=conflicts round=1 -->'), undefined);
    assert.equal(readRepairMarker('a plain comment'), undefined);
  });

  test('a rerun marker carries the head whose failed jobs were rerun', () => {
    assert.equal(rerunMarker('abc123'), '<!-- phat-mode:rerun sha=abc123 -->');
    assert.equal(readRerunMarker(`${rerunMarker('abc123')}\ntext`), 'abc123');
    assert.equal(readRerunMarker('a plain comment'), undefined);
  });

  test('a base-red marker carries the head, the base branch’s head diagnose saw, and the cause', () => {
    const marker = baseRedMarker({ head: 'abc123', base: 'f00d', cause: 'flaky' });
    assert.equal(marker, '<!-- phat-mode:base-red head=abc123 base=f00d cause=flaky -->');
    assert.deepEqual(readBaseRedMarker(`${marker}\ntext`), { head: 'abc123', base: 'f00d', cause: 'flaky' });
    assert.equal(readBaseRedMarker('<!-- phat-mode:base-red head=abc base=f00d cause=other -->'), undefined);
  });

  test('a give-up marker carries its round', () => {
    assert.equal(giveUpMarker(2), '<!-- phat-mode:repair-gave-up round=2 -->');
    assert.equal(readGiveUpMarker(`${giveUpMarker(2)}\nsummary`), 2);
    assert.equal(readGiveUpMarker('nothing'), undefined);
  });
});
