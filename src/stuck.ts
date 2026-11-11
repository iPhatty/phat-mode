import type { CheckState, GitHub, PostedComment, PullRequestStatus } from './github.ts';
import { PROGRESS_LABELS } from './github.ts';
import { clock, readYoloMarker, SETTLE_MS } from './yolo.ts';

/**
 * Why one of phat-mode's open pull requests is stuck, worked out from GitHub alone, like `yoloMerge`: its status and
 * the comments phat-mode posted on it. See docs/adr/0006-repair-is-its-own-task-kind.md.
 *
 * Repair keeps its state on the pull request, in hidden markers: one comment per repair, carrying the repair's number,
 * the head commit it repaired, its cause and its round; and a summary comment carrying a give-up marker when repair
 * gives up. Only repairs after the last give-up count against `limits.maxRepairs`, so removing `phat-mode:stuck` gives
 * a fresh budget.
 */

/** What made a pull request stuck: failed checks, conflicts with its base branch (or behind it), or not clean. */
export type RepairCause = 'conflicts' | 'checks' | 'not-clean';
const CAUSES: readonly RepairCause[] = ['conflicts', 'checks', 'not-clean'];

/**
 * The causes repair handles so far. Not clean is reported as stuck, but those pull requests wait as before, until
 * repair handles them.
 */
export const REPAIRED_CAUSES: readonly RepairCause[] = ['conflicts', 'checks'];

/** One repair, as its comment's marker records it. `round`: repairs since the last give-up are in the same round. */
export type RepairMarker = { n: number; sha: string; cause: RepairCause; round: number };

export function repairMarker({ n, sha, cause, round }: RepairMarker): string {
  return `<!-- phat-mode:repair n=${n} sha=${sha} cause=${cause} round=${round} -->`;
}

const REPAIR = /<!-- phat-mode:repair n=(\d+) sha=([0-9a-f]+) cause=([a-z-]+) round=(\d+) -->/;

/** The repair marker in a comment; undefined if there is none. */
export function readRepairMarker(body: string): RepairMarker | undefined {
  const match = REPAIR.exec(body);
  if (match === null || !CAUSES.includes(match[3] as RepairCause)) return undefined;
  return { n: Number(match[1]), sha: match[2]!, cause: match[3] as RepairCause, round: Number(match[4]) };
}

/** The marker on the summary comment repair posts when it gives up, ending round `round`. */
export const giveUpMarker = (round: number) => `<!-- phat-mode:repair-gave-up round=${round} -->`;

const GIVE_UP = /<!-- phat-mode:repair-gave-up round=(\d+) -->/;

export function readGiveUpMarker(body: string): number | undefined {
  const match = GIVE_UP.exec(body);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The marker on the comment repair posts when it reruns a head's failed GitHub Actions jobs: once per head, and not a
 * repair, so it spends no attempt.
 */
export const rerunMarker = (sha: string) => `<!-- phat-mode:rerun sha=${sha} -->`;

const RERUN = /<!-- phat-mode:rerun sha=([0-9a-f]+) -->/;

/** The head a rerun marker names; undefined if there is none. */
export function readRerunMarker(body: string): string | undefined {
  return RERUN.exec(body)?.[1];
}

/** Why diagnose judged that failed checks are not this change's: they fail on the base branch too, or are flaky. */
export type BaseRedCause = 'base-red' | 'flaky';
const BASE_RED_CAUSES: readonly BaseRedCause[] = ['base-red', 'flaky'];

/**
 * A head whose failed checks are not this change's, and the base branch's head when diagnose said so: repair waits,
 * spending no attempt, until the base branch moves on.
 */
export type BaseRed = { head: string; base: string; cause: BaseRedCause };

export const baseRedMarker = ({ head, base, cause }: BaseRed) => `<!-- phat-mode:base-red head=${head} base=${base} cause=${cause} -->`;

const BASE_RED = /<!-- phat-mode:base-red head=([0-9a-f]+) base=([0-9a-f]+) cause=([a-z-]+) -->/;

export function readBaseRedMarker(body: string): BaseRed | undefined {
  const match = BASE_RED.exec(body);
  if (match === null || !BASE_RED_CAUSES.includes(match[3] as BaseRedCause)) return undefined;
  return { head: match[1]!, base: match[2]!, cause: match[3] as BaseRedCause };
}

/** The newest base-red marker for `head`, if any. */
const baseRedFor = (comments: readonly PostedComment[], head: string) =>
  comments.flatMap((comment) => {
    const marker = readBaseRedMarker(comment.body);
    return marker?.head === head ? [marker] : [];
  }).at(-1);

/** Why repair waits on a head diagnose judged base red or flaky, e.g. `ci/test fails on main too`. */
export function baseRedReason(cause: BaseRedCause, failed: readonly string[], baseBranch: string): string {
  const names = failed.join(', ');
  return cause === 'base-red'
    ? `${names} ${failed.length === 1 ? 'fails' : 'fail'} on ${baseBranch} too`
    : `${names} failed, judged flaky: waiting for ${baseBranch} to move on`;
}

/** A repair comment and its marker. */
export type Attempt = RepairMarker & { body: string };

/**
 * The repairs so far in the current round: those after the last give-up, oldest first. `round`: the current round,
 * one after the last give-up's.
 */
export function repairHistory(comments: readonly PostedComment[]): { round: number; attempts: Attempt[] } {
  let round = 1;
  let attempts: Attempt[] = [];
  for (const comment of comments) {
    const gaveUp = readGiveUpMarker(comment.body);
    if (gaveUp !== undefined) {
      round = Math.max(round, gaveUp + 1);
      attempts = [];
      continue;
    }
    const marker = readRepairMarker(comment.body);
    if (marker !== undefined) attempts.push({ ...marker, body: comment.body });
  }
  return { round, attempts };
}

/** Every repair of round `round`, oldest first, wherever it is among the comments. */
export function attemptsOf(comments: readonly PostedComment[], round: number): Attempt[] {
  return comments.flatMap((comment) => {
    const marker = readRepairMarker(comment.body);
    return marker !== undefined && marker.round === round ? [{ ...marker, body: comment.body }] : [];
  });
}

/**
 * What GitHub says about a pull request, and the comments phat-mode posted on it (the `gh` user's only). `baseHead`: the
 * base branch's head commit, when a base-red marker holds the pull request's head.
 */
export type StuckFacts = { status: PullRequestStatus; comments: readonly PostedComment[]; baseHead?: string };

export type StuckOptions = { maxRepairs: number; now: Date; baseBranch: string };

/**
 * Why a pull request is or is not stuck, each with a one-line reason:
 * - leave: not phat-mode's to repair (no verdict, or a human pushed commits);
 * - paused: a human requested changes after phat-mode's last push;
 * - stuck: labelled `phat-mode:stuck`, waiting for a human;
 * - wait: checks are running, the head has not settled, failed jobs were just rerun, or its failed checks are not
 *   this change's (base red or flaky) and the base branch has not moved on since; `onWaitingLine`: watch says why;
 * - repair: stuck by `cause`, with budget left: repair `n` of `round`, on `head`; `rerun`: failed checks whose GitHub
 *   Actions jobs were not rerun on this head yet, which repair does first; `giveUp`: for failed checks, the budget is
 *   spent or this head was repaired already, so repair gives up if diagnose finds the change caused them;
 * - give_up: stuck by `cause` (not failed checks), and the budget is spent or this head was repaired already;
 * - not_stuck.
 */
export type StuckOutcome =
  | { kind: 'leave'; reason: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'stuck'; reason: string }
  | { kind: 'wait'; reason: string; settlesAt?: Date; onWaitingLine?: true }
  | { kind: 'repair'; cause: RepairCause; reason: string; head: string; n: number; round: number; rerun?: true; giveUp?: string }
  | { kind: 'give_up'; cause: RepairCause; reason: string; head: string; round: number }
  | { kind: 'not_stuck'; reason: string };

/** Review states that pause repair; comments, approvals and dismissed reviews never do. */
const PAUSES = 'CHANGES_REQUESTED';

/**
 * Rules 1–4: why repair must leave the pull request alone, if it must. `heads`: the commits repair may find at its head;
 * by default only the one phat-mode judged (its verdict marker's). `ignoreStuckLabel`: for a give-up already under way,
 * which may have set the label itself. Undefined when repair may go on.
 */
export function whyLeftAlone(
  status: PullRequestStatus,
  heads?: readonly string[],
  { ignoreStuckLabel = false }: { ignoreStuckLabel?: boolean } = {},
): Extract<StuckOutcome, { kind: 'leave' | 'paused' | 'stuck' }> | undefined {
  // 1–2. phat-mode's own, unchanged since it pushed.
  const verdict = readYoloMarker(status.body);
  if (verdict === undefined) return { kind: 'leave', reason: 'phat-mode left no verdict on it' };
  if (!(heads ?? [verdict.sha]).includes(status.head.sha)) return { kind: 'leave', reason: 'commits added after phat-mode' };
  // 3. phat-mode's last push is its head commit, made just before it pushed.
  const pushedAt = Date.parse(status.head.committedAt);
  const requested = status.reviews.filter((review) => review.state === PAUSES && Date.parse(review.submittedAt) > pushedAt);
  if (requested.length > 0) {
    const who = [...new Set(requested.map((review) => `@${review.author}`))].join(', ');
    return { kind: 'paused', reason: `repair paused: changes requested by ${who}` };
  }
  // 4.
  if (!ignoreStuckLabel && status.labels.includes(PROGRESS_LABELS.stuck.name)) {
    return { kind: 'stuck', reason: `${PROGRESS_LABELS.stuck.name}: waiting for you` };
  }
  return undefined;
}

/** Why a pull request is stuck, decided from GitHub alone. */
export function whyStuck({ status, comments, baseHead }: StuckFacts, { maxRepairs, now, baseBranch }: StuckOptions): StuckOutcome {
  const left = whyLeftAlone(status);
  if (left !== undefined) return left;
  const verdict = readYoloMarker(status.body)!;
  // 6–10: what is wrong, if anything.
  const stuck = causeOf(status, verdict, now, baseBranch);
  if (stuck.kind !== 'stuck') return stuck;
  const head = status.head.sha;
  let rerun = false;
  if (stuck.cause === 'checks') {
    // A rerun spends no attempt; until its checks show up as running, GitHub may still report the old failures.
    const reran = comments.filter((comment) => readRerunMarker(comment.body) === head).at(-1);
    if (reran !== undefined) {
      const settlesAt = new Date(Date.parse(reran.createdAt) + SETTLE_MS);
      if (now < settlesAt) return { kind: 'wait', reason: `rerunning failed jobs (until ${clock(settlesAt)})`, settlesAt };
    }
    rerun = reran === undefined;
    // Not this change's failures: wait, without spending an attempt or giving up, until the base branch moves on.
    const red = baseRedFor(comments, head);
    if (red !== undefined && red.base === baseHead) {
      const failed = status.checks.filter((check) => check.state === 'failed').map((check) => check.name);
      return { kind: 'wait', reason: baseRedReason(red.cause, failed, baseBranch), onWaitingLine: true };
    }
  }
  // 5. The budget: only for a pull request that is stuck.
  const { round, attempts } = repairHistory(comments);
  const { cause } = stuck;
  const spent = new Set(attempts.map((attempt) => attempt.sha)).size;
  const exhausted = attempts.some((attempt) => attempt.sha === head)
    ? `gave up: a repair already ran on ${head}`
    : spent >= maxRepairs
      ? `gave up: ${spent} repair${spent === 1 ? '' : 's'} spent`
      : undefined;
  const n = Math.max(0, ...attempts.map((attempt) => attempt.n)) + 1;
  // Failed checks still get their rerun and diagnosis, which spend no attempt: the budget applies only once diagnose
  // finds the change caused them, and then `giveUp` says why repair gives up instead.
  if (cause === 'checks') {
    return {
      kind: 'repair',
      cause,
      reason: stuck.reason,
      head,
      n,
      round,
      ...(rerun ? { rerun: true as const } : {}),
      ...(exhausted === undefined ? {} : { giveUp: exhausted }),
    };
  }
  if (exhausted !== undefined) return { kind: 'give_up', cause, reason: exhausted, head, round };
  return { kind: 'repair', cause, reason: stuck.reason, head, n, round };
}

/** Rules 6–10: conflicts, not clean, still waiting, failed checks, or nothing wrong. */
function causeOf(
  status: PullRequestStatus,
  verdict: NonNullable<ReturnType<typeof readYoloMarker>>,
  now: Date,
  baseBranch: string,
): { kind: 'stuck'; cause: RepairCause; reason: string } | Extract<StuckOutcome, { kind: 'wait' | 'not_stuck' }> {
  if (status.mergeable === 'CONFLICTING' || status.mergeState === 'DIRTY') {
    return { kind: 'stuck', cause: 'conflicts', reason: `conflicts with ${baseBranch}` };
  }
  if (status.mergeState === 'BEHIND') {
    return { kind: 'stuck', cause: 'conflicts', reason: `behind ${baseBranch}, which must be up to date to merge` };
  }
  if (verdict.verdict === 'not-clean') return { kind: 'stuck', cause: 'not-clean', reason: `not clean: ${verdict.reason}` };
  const named = (state: CheckState) => status.checks.filter((check) => check.state === state).map((check) => check.name);
  const running = named('running');
  if (running.length > 0) return { kind: 'wait', reason: `checks running: ${running.join(', ')}` };
  const settlesAt = new Date(Date.parse(status.head.committedAt) + SETTLE_MS);
  if (now < settlesAt) return { kind: 'wait', reason: `settling (until ${clock(settlesAt)})`, settlesAt };
  const failed = named('failed');
  if (failed.length > 0) return { kind: 'stuck', cause: 'checks', reason: `checks failed: ${failed.join(', ')}` };
  return { kind: 'not_stuck', reason: 'not stuck' };
}

/** Read what `whyStuck` needs of pull request `pr` from GitHub, and decide. */
export async function lookAtPullRequest(
  github: Pick<GitHub, 'pullRequestStatus' | 'phatModeComments' | 'commitChecks'>,
  pr: { number: number },
  options: StuckOptions,
): Promise<StuckOutcome> {
  const [status, comments] = await Promise.all([github.pullRequestStatus(pr.number), github.phatModeComments(pr.number)]);
  // The base branch's head only matters while a base-red marker holds this head.
  const baseHead =
    baseRedFor(comments, status.head.sha) === undefined ? undefined : (await github.commitChecks(options.baseBranch)).sha;
  return whyStuck({ status, comments, ...(baseHead === undefined ? {} : { baseHead }) }, options);
}
