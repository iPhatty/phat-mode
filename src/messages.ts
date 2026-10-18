import type { DoneReport, ReviewReport, TriageReport } from './agents.ts';
import type { Issue } from './github.ts';

const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');

export function planComment(triage: TriageReport): string {
  return `🤖 **phat-mode is working on this.**

${triage.summary}

**Plan**
${list(triage.plan)}

I'll open a draft pull request when the checks pass and the review is done.`;
}

export function needsInfoComment(triage: TriageReport): string {
  return `🤖 **phat-mode needs more detail before starting.**

${triage.summary}

${list(triage.questions)}

Edit the issue to answer, then run phat-mode on it again.`;
}

export function rejectedComment(triage: TriageReport): string {
  return `🤖 **phat-mode will not work on this issue.**

${triage.summary}`;
}

export function failedComment(reason: string): string {
  return `🤖 **phat-mode could not finish this issue.**

${reason}

Nothing was merged. The work so far is on the \`phat-mode\` branch for this issue, if any.`;
}

export function doneComment(prUrl: string): string {
  return `🤖 **phat-mode opened a draft pull request:** ${prUrl}`;
}

export type PullRequestDetails = {
  issue: Issue;
  triage: TriageReport;
  done: DoneReport | undefined;
  review: ReviewReport | undefined;
  /** Findings still open after the last review round. */
  unresolved: readonly string[];
  checkCommand: string;
};

export function pullRequestTitle(issue: Issue): string {
  return `${issue.title} (#${issue.number})`;
}

export function pullRequestBody(details: PullRequestDetails): string {
  const { issue, triage, done, review, unresolved, checkCommand } = details;
  const sections = [
    `Closes #${issue.number}`,
    `## Summary\n\n${done?.summary ?? triage.summary}`,
    `## Plan\n\n${list(triage.plan)}`,
    `## Testing\n\n${done?.testing ? `${done.testing}\n\n` : ''}✅ \`${checkCommand}\` passes.`,
  ];
  if (unresolved.length > 0) {
    sections.push(`## ⚠️ Unresolved review findings\n\n${list(unresolved)}`);
  } else if (review !== undefined) {
    sections.push(`## Review\n\n✅ Approved by the reviewer agent. ${review.summary}`);
  }
  sections.push(
    '---\n🤖 Opened by phat-mode. This is a draft: a human must review and merge it.',
  );
  return sections.join('\n\n');
}
