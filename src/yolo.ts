import type { CodeReview } from './code-review.ts';
import { branchFor } from './config.ts';
import type { CheckState, GitHub } from './github.ts';
import type { RepairResult } from './repair.ts';
import { lookAtPullRequest } from './stuck.ts';
import type { Verification } from './verify.ts';

/**
 * `--yolo`: phat-mode merges its own pull request once nothing is left for a human to look at. See
 * docs/adr/0002-yolo-merges.md.
 *
 * The run that opens a pull request decides whether it is clean, and writes that, with the exact commit it pushed, in
 * a hidden marker in the description. Yolo reads the marker from GitHub, so it needs nothing saved locally.
 */

/** phat-mode's verdict on its own pull request. `sha`: the commit it pushed, the only one the verdict is about. */
export type YoloVerdict = { verdict: 'clean'; sha: string } | { verdict: 'not-clean'; sha: string; reason: string };

/** The hidden marker for the pull request description. */
export function yoloMarker(verdict: YoloVerdict): string {
  if (verdict.verdict === 'clean') return `<!-- phat-mode:yolo clean sha=${verdict.sha} -->`;
  // The reason is phat-mode's own text; keep it from ending the comment or the quoted value.
  const reason = verdict.reason.replaceAll('"', "'").replaceAll('--', '-').replace(/\s+/g, ' ').trim();
  return `<!-- phat-mode:yolo not-clean sha=${verdict.sha} reason="${reason}" -->`;
}

const MARKER = /<!-- phat-mode:yolo (clean|not-clean) sha=([0-9a-f]+)(?: reason="([^"]*)")? -->/;

/** The verdict in a pull request description; undefined if there is none (e.g. opened by an older phat-mode). */
export function readYoloMarker(body: string): YoloVerdict | undefined {
  const match = MARKER.exec(body);
  if (match === null) return undefined;
  const [, verdict, sha, reason] = match;
  return verdict === 'clean' ? { verdict: 'clean', sha: sha! } : { verdict: 'not-clean', sha: sha!, reason: reason ?? '' };
}

/** What a run found, as far as yolo cares. */
export type RunFindings = {
  /** The last code review; a reviewer that did not report is null in it. */
  review: CodeReview | null;
  /** Must-fix code review findings were still open after the last round. */
  unresolved: boolean;
  verification: Verification;
};

/** Whether the pull request at `sha` is clean: nothing left for a human to look at. */
export function verdictFor(sha: string, run: RunFindings): YoloVerdict {
  const reason = notCleanBecause(run);
  return reason === undefined ? { verdict: 'clean', sha } : { verdict: 'not-clean', sha, reason };
}

/** Why phat-mode judged a pull request not clean: the reasons its verdict marker carries. */
export const NOT_CLEAN = {
  reviewerSilent: 'a code reviewer did not report',
  openFindings: 'code review has open findings',
  skillChanged: 'the implementer changed the verification skill',
  verificationFailed: 'verification found failures this change caused',
  verifierSilent: 'the verifier did not report',
  couldNotRun: 'verification could not run',
} as const;

const VERIFICATION_REASONS: readonly string[] = [
  NOT_CLEAN.skillChanged,
  NOT_CLEAN.verificationFailed,
  NOT_CLEAN.verifierSilent,
  NOT_CLEAN.couldNotRun,
];

/** Whether a not-clean verdict's reason was verification, rather than the code review. */
export const verificationWasTheReason = (reason: string) => VERIFICATION_REASONS.includes(reason);

/**
 * Anything that went wrong in this run. A repo without a verification skill chose not to have one, so skipped
 * verification is fine; so are smells, pre-existing failures and feature map edits, which never block a PR either.
 */
function notCleanBecause({ review, unresolved, verification }: RunFindings): string | undefined {
  if (review === null || review.standards === null || review.spec === null) return NOT_CLEAN.reviewerSilent;
  if (unresolved) return NOT_CLEAN.openFindings;
  if (verification.kind === 'skipped') return undefined;
  if (verification.reverted.length > 0) return NOT_CLEAN.skillChanged;
  if (verification.unresolved) return NOT_CLEAN.verificationFailed;
  if (verification.report === null) return NOT_CLEAN.verifierSilent;
  if (verification.report.couldNotRun.trim()) return NOT_CLEAN.couldNotRun;
  return undefined;
}

// ─── Merging ────────────────────────────────────────────────────────────────

/** One of phat-mode's open pull requests. */
export type OpenPullRequest = { number: number; url: string; issue: number };

/**
 * Merged, or why not. `needsYou`: only a human can move it on; otherwise it may still merge on a later look (checks
 * running, settling). `settlesAt`: when only settling is left, the time it can merge.
 */
export type MergeOutcome = { merged: true } | { merged: false; needsYou: boolean; reason: string; settlesAt?: Date };

/**
 * How long the head commit must have been on GitHub before yolo merges it. Checks show up a little after a push, so a
 * pull request without any yet may only be waiting for them.
 */
export const SETTLE_MS = 60_000;

/** Added to a wait for settling, so the next look is surely past it, even if a timer fires a little early. */
const SETTLE_SLACK_MS = 1_000;

/** Local time, as HH:MM. */
export const clock = (time: Date) =>
  `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

/** GitHub's reason, without the command that failed; its first line. */
function refusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[^]*? exited with \d+: /, '').split('\n')[0]!.trim();
}

const yours = (reason: string): MergeOutcome => ({ merged: false, needsYou: true, reason });
const notYet = (reason: string): MergeOutcome => ({ merged: false, needsYou: false, reason });

/** Merge `pr` if nothing is left for a human: see docs/adr/0002-yolo-merges.md. */
export async function yoloMerge(
  github: GitHub,
  pr: OpenPullRequest,
  options: { command: 'watch' | 'run'; now: Date },
): Promise<MergeOutcome> {
  const status = await github.pullRequestStatus(pr.number);
  const verdict = readYoloMarker(status.body);
  if (verdict === undefined) return yours('phat-mode left no verdict on it');
  if (verdict.verdict === 'not-clean') return yours(verdict.reason);
  if (status.head.sha !== verdict.sha) return yours('commits added after phat-mode');
  const named = (state: CheckState) => status.checks.filter((check) => check.state === state).map((check) => check.name);
  const failed = named('failed');
  if (failed.length > 0) return yours(`checks failed: ${failed.join(', ')}`);
  const running = named('running');
  if (running.length > 0) return notYet(`checks running: ${running.join(', ')}`);
  const settled = new Date(Date.parse(status.head.committedAt) + SETTLE_MS);
  if (options.now < settled)
    return { merged: false, needsYou: false, reason: `settling (merges after ${clock(settled)})`, settlesAt: settled };
  // Only the commit phat-mode judged: GitHub refuses if anything was pushed since.
  try {
    await github.mergePullRequest(pr.number, verdict.sha);
  } catch (error) {
    return yours(`GitHub refused: ${refusal(error)}`);
  }
  const checks = status.checks.length;
  const passed = checks === 0 ? 'there are no checks on it' : checks === 1 ? 'its 1 check passed' : `all ${checks} checks passed`;
  await github.commentOnPullRequest(
    pr.number,
    `Merged by \`phat-mode ${options.command} --yolo\`: phat-mode found it clean, and ${passed}.`,
  );
  return { merged: true };
}

/**
 * `run --yolo`, once the pull request for `issue` is open: look every `intervalMs` until it merges, or until only a
 * human can move it on; when only settling is left, look again as soon as it has settled instead. `say`: each new
 * reason it is not merged yet.
 *
 * `repair`: with repair on, each look first decides whether the pull request is stuck (src/stuck.ts). One repair can
 * fix is repaired by `repair.run` (the durable Repair task), and the loop looks again at once; it merges only once
 * nothing is stuck. It stops, with the reason, when repair leaves the pull request alone (`phat-mode:stuck`, paused by
 * a review, human commits, no verdict) or the repair gave up. Without it, failed checks and not clean stop the wait.
 */
export async function waitToMerge(
  github: GitHub,
  issue: number,
  options: {
    intervalMs: number;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    say: (text: string) => void;
    repair?: RepairLook & { run: (pr: { number: number; url: string }) => Promise<RepairResult> };
  },
): Promise<{ merged: true; url: string } | { merged: false; reason: string; url?: string }> {
  let said: string | undefined;
  const say = (text: string) => {
    if (text !== said) options.say(text);
    said = text;
  };
  const sleepUntil = (settlesAt: Date | undefined) => {
    const untilSettled = settlesAt && settlesAt.getTime() - options.now().getTime() + SETTLE_SLACK_MS;
    return options.sleep(Math.min(options.intervalMs, untilSettled ?? Infinity));
  };
  /** The head the last repair ran on, when it published nothing: a repair on it again waits an interval first. */
  let unchanged: string | undefined;
  for (;;) {
    const pr = await github.findPullRequest(branchFor(issue));
    if (pr === undefined) return { merged: false, reason: 'no open pull request' };
    if (options.repair !== undefined) {
      const { run, ...look } = options.repair;
      const stuck = await lookAtPullRequest(github, pr, { ...look, now: options.now() });
      if (stuck.kind === 'leave' || stuck.kind === 'paused' || stuck.kind === 'stuck') {
        return { merged: false, reason: stuck.reason, url: pr.url };
      }
      if (stuck.kind === 'repair' || stuck.kind === 'give_up') {
        if (stuck.head === unchanged) await options.sleep(options.intervalMs);
        say(`repairing: ${stuck.reason}`);
        const result = await run(pr);
        if (result.status === 'stuck') return { merged: false, reason: result.reason, url: pr.url };
        say(result.status === 'repaired' ? `repaired: ${result.url}` : `${result.status === 'waiting' ? 'waiting' : 'not repaired'}: ${result.reason}`);
        unchanged = result.status === 'repaired' ? undefined : stuck.head;
        continue;
      }
      if (stuck.kind === 'wait') {
        say(stuck.reason);
        await sleepUntil(stuck.settlesAt);
        continue;
      }
    }
    const outcome = await yoloMerge(github, { ...pr, issue }, { command: 'run', now: options.now() });
    if (outcome.merged) return { merged: true, url: pr.url };
    if (outcome.needsYou) {
      // yoloMerge reads GitHub again: a check may have failed, or the base branch moved on, since the look. With repair
      // on, it is yours only if the pull request, looked at again, is still not stuck; otherwise the next look acts.
      if (options.repair !== undefined) {
        const { run: _run, ...look } = options.repair;
        if ((await lookAtPullRequest(github, pr, { ...look, now: options.now() })).kind !== 'not_stuck') continue;
      }
      return { merged: false, reason: outcome.reason, url: pr.url };
    }
    say(outcome.reason);
    await sleepUntil(outcome.settlesAt);
  }
}

/** How `run` and `run --yolo` look at an open pull request with repair on: `repair` in config.json, the default. */
export type RepairLook = { maxRepairs: number; baseBranch: string };

/**
 * What `run` does first:
 * - run: start a run, or resume the one going (whatever its kind, e.g. a repair stopped by Ctrl-C);
 * - wait: `--yolo` with the pull request open: wait to merge it (the wait repairs what it can);
 * - repair: the pull request is stuck in a way repair handles: repair it;
 * - open: the pull request is open and there is nothing to repair; `needsYou`: repair leaves it alone (paused by a
 *   review, `phat-mode:stuck`, human commits, no verdict), otherwise it only waits (checks running, settling, base red).
 */
export type RunStep =
  | { kind: 'run' }
  | { kind: 'wait' }
  | { kind: 'repair'; url: string; reason: string }
  | { kind: 'open'; url: string; reason: string; needsYou: boolean };

/**
 * What `run` does first. A run that is going is resumed (it opens, updates or repairs the pull request). Otherwise, if
 * the issue's pull request is already open, e.g. after Ctrl-C while waiting, or from a run without --yolo: with --yolo
 * it only waits for the merge, as a new run would redo the work just to update the same pull request; without, it
 * repairs the pull request if it is stuck, and says why not otherwise. `repair`: absent with `repair: false`, which
 * starts a new run, as before.
 */
export async function runOrWait(
  github: GitHub,
  issue: number,
  { runGoing, yolo, repair }: { runGoing: boolean; yolo: boolean; repair?: RepairLook & { now: Date } },
): Promise<RunStep> {
  if (runGoing) return { kind: 'run' };
  const pr = await github.findPullRequest(branchFor(issue));
  if (pr === undefined) return { kind: 'run' };
  if (yolo) return { kind: 'wait' };
  if (repair === undefined) return { kind: 'run' };
  const outcome = await lookAtPullRequest(github, pr, repair);
  switch (outcome.kind) {
    case 'repair':
    case 'give_up':
      return { kind: 'repair', url: pr.url, reason: outcome.reason };
    case 'leave':
    case 'paused':
    case 'stuck':
      return { kind: 'open', url: pr.url, reason: outcome.reason, needsYou: true };
    case 'wait':
    case 'not_stuck':
      return { kind: 'open', url: pr.url, reason: outcome.reason, needsYou: false };
  }
}
