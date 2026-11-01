import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { CheckState } from '../src/github.ts';
import { silentLogger } from '../src/log.ts';
import { describeStep, MARKER_HANDED_BACK, nextStep } from '../src/watch.ts';
import { yoloMarker, type YoloVerdict } from '../src/yolo.ts';
import { FakeGitHub, testConfig } from './fakes.ts';

const config: Config = testConfig('/nonexistent');
const step = (github: FakeGitHub) => nextStep(github, config, silentLogger);
const NOW = new Date('2026-10-31T12:00:00Z');
const yoloStep = (github: FakeGitHub) => nextStep(github, config, silentLogger, { yolo: true, now: NOW });

/** Open issues, each blocked by the issues listed (GitHub's native dependencies). */
function repo(issues: Record<number, { blockedBy?: number[]; labels?: string[]; author?: string }>) {
  const github = new FakeGitHub();
  for (const [key, options] of Object.entries(issues)) {
    const number = Number(key);
    github.addIssue(number, {
      labels: options.labels ?? ['ready-for-agent'],
      ...(options.author ? { author: options.author } : {}),
    });
    github.openIssues.add(number);
    if (options.blockedBy) github.native.set(number, options.blockedBy);
  }
  return github;
}

/** What GitHub does when a phat-mode pull request merges: `Closes #N` closes the issue. */
function merge(github: FakeGitHub, issue: number) {
  const pr = github.prs.find((candidate) => candidate.branch === `phat-mode/issue-${issue}` && candidate.state === 'OPEN')!;
  pr.state = 'MERGED';
  github.issues.get(issue)!.state = 'CLOSED';
  github.openIssues.delete(issue);
}

/** What a finished run leaves behind. */
function opened(github: FakeGitHub, issue: number) {
  github.issues.get(issue)!.labels.push('phat-mode:done');
  github.addPullRequest({ branch: `phat-mode/issue-${issue}` });
}

/** A finished run's pull request with phat-mode's verdict on it; settled, with its checks passed, unless told otherwise. */
function judged(
  github: FakeGitHub,
  issue: number,
  verdict: 'clean' | YoloVerdict = 'clean',
  checks: { name: string; state: CheckState }[] = [{ name: 'test', state: 'passed' }],
) {
  opened(github, issue);
  const pr = github.prs.at(-1)!;
  const sha = `cafe${issue}`;
  pr.body = `Adds it.\n\n${yoloMarker(verdict === 'clean' ? { verdict: 'clean', sha } : verdict)}`;
  github.statuses.set(pr.number, { head: { sha, committedAt: '2026-10-31T11:00:00Z' }, checks });
  return pr;
}

describe('watch --yolo', () => {
  test('merges a clean pull request, then starts the next ready issue in the same look', async () => {
    const github = repo({ 2: {}, 3: {} });
    const pr = judged(github, 2);
    assert.deepEqual(await yoloStep(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: 'cafe2' }]);
  });

  test('merges every clean one, lowest issue first; the others wait, each saying why', async () => {
    const github = repo({ 2: {}, 3: {}, 4: {}, 5: {} });
    const findings = judged(github, 2, { verdict: 'not-clean', sha: 'cafe2', reason: 'code review has open findings' });
    const second = judged(github, 4);
    const running = judged(github, 3, 'clean', [{ name: 'build', state: 'running' }]);
    const first = judged(github, 5);
    // Opened in another order: still merged lowest issue first.
    const step = await yoloStep(github);
    assert.deepEqual(github.merges.map((merge) => merge.pr), [second.number, first.number]);
    assert.deepEqual(step, {
      kind: 'wait_for_merge',
      prs: [
        { issue: 2, url: findings.url, notMerging: { needsYou: true, reason: 'code review has open findings' } },
        { issue: 3, url: running.url, notMerging: { needsYou: false, reason: 'checks running: build' } },
      ],
    });
    assert.equal(
      describeStep(step),
      `Waiting for you to merge #2: ${findings.url} (not merging: code review has open findings); ` +
        `waiting to merge #3: ${running.url} (checks running: build)`,
    );
  });

  test('without --yolo, nothing is ever merged, even a clean pull request', async () => {
    const github = repo({ 2: {} });
    const pr = judged(github, 2);
    assert.deepEqual(await step(github), { kind: 'wait_for_merge', prs: [{ issue: 2, url: pr.url }] });
    assert.equal(github.writes, 0);
  });
});

describe('watch', () => {
  test('starts the lowest-numbered ready issue', async () => {
    const github = repo({ 3: {}, 2: {}, 5: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 2, title: 'Issue 2' });
  });

  test('waits while a phat-mode pull request is open, then moves on once it merges', async () => {
    const github = repo({ 2: {}, 3: {} });
    opened(github, 2);
    // Someone else's pull request never holds the queue up.
    github.addPullRequest({ branch: 'feature/other' });
    const waiting = await step(github);
    assert.deepEqual(waiting, { kind: 'wait_for_merge', prs: [{ issue: 2, url: github.prs[0]!.url }] });
    assert.match(describeStep(waiting), /Waiting for you to merge #2: https:\/\/github\.test\/pull\/100/);

    merge(github, 2);
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.equal(github.writes, 0, 'nothing written on GitHub');
  });

  test('skips blocked issues, even lower-numbered ones, and picks them up when the blocker merges', async () => {
    // As in phatty-lingo: #9 waits for #18.
    const github = repo({ 9: { blockedBy: [18] }, 18: {}, 19: { blockedBy: [18] } });
    assert.deepEqual(await step(github), { kind: 'start', issue: 18, title: 'Issue 18' });
    opened(github, 18);
    merge(github, 18);
    assert.deepEqual(await step(github), { kind: 'start', issue: 9, title: 'Issue 9' });
  });

  test('a done issue whose pull request merged is not started again while GitHub closes it', async () => {
    const github = repo({ 2: {}, 3: { blockedBy: [2] } });
    opened(github, 2);
    github.prs[0]!.state = 'MERGED';
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.match(describeStep(idle), /#3 is blocked by #2 \(its pull request is merged, GitHub has not closed it yet\)/);
  });

  test('a pull request closed without merging hands its issue to a human, and the queue moves on', async () => {
    const github = repo({ 2: {}, 3: {} });
    opened(github, 2);
    github.prs[0]!.state = 'CLOSED';
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.deepEqual(github.labels(2), ['ready-for-human']);
    const comment = github.comments.find((candidate) => candidate.issue === 2)!;
    assert.equal(comment.marker, MARKER_HANDED_BACK);
    assert.match(comment.body, /closed without merging[^]*label it `ready-for-agent`/);
  });

  test('relabelled ready-for-agent after a failure or a hand-back: tried again', async () => {
    const github = repo({ 4: { labels: ['ready-for-agent', 'ready-for-human', 'phat-mode:failed'] } });
    assert.deepEqual(await step(github), { kind: 'start', issue: 4, title: 'Issue 4' });
  });

  test('never starts an issue labelled phat-mode:working; says why', async () => {
    const github = repo({ 2: { labels: ['ready-for-agent', 'phat-mode:working'] } });
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.match(describeStep(idle), /#2 is labelled phat-mode:working, but no run is going/);
  });

  test('ignores issues nobody trusted specified', async () => {
    const github = repo({ 2: { author: 'stranger' }, 3: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
  });

  test('never builds an issue labelled agent-mode; says why', async () => {
    const github = repo({ 2: { labels: ['ready-for-agent', 'agent-mode'] }, 3: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    const alone = repo({ 2: { labels: ['ready-for-agent', 'agent-mode'] } });
    const idle = await step(alone);
    assert.equal(idle.kind, 'idle');
    assert.match(describeStep(idle), /#2 is labelled `agent-mode`: phat-mode shapes it into tickets, it does not build it/);
  });

  test('nothing can start: says what each issue waits for, down to the human', async () => {
    const github = repo({
      9: { blockedBy: [18] },
      18: { labels: ['ready-for-human'] },
      19: { blockedBy: [9] },
    });
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.equal(
      describeStep(idle),
      'Nothing can start:\n    - #9 is blocked by #18 (ready-for-human)\n    - #19 is blocked by #9 (ready-for-agent, but blocked itself)',
    );
  });

  test('nothing ready at all', async () => {
    assert.equal(describeStep(await step(new FakeGitHub())), 'Nothing labelled ready-for-agent. Waiting for new issues.');
  });
});
