import { DEFAULT_LABELS, type Labels } from './config.ts';
import { run } from './exec.ts';

export type Comment = {
  author: string;
  body: string;
  createdAt: string;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: string[];
  comments: Comment[];
};

export type PullRequest = {
  number: number;
  url: string;
  isDraft: boolean;
};

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

/** A check on a commit, as one of three: skipped and neutral count as passed. */
export type CheckState = 'passed' | 'running' | 'failed';

/** What decides whether a pull request can merge: its description, its head commit, and the checks on that commit. */
export type PullRequestStatus = {
  body: string;
  /** `committedAt`: when the head commit was made (phat-mode commits just before it pushes). */
  head: { sha: string; committedAt: string };
  /** Check runs (GitHub Actions and other apps) and commit statuses, by name. */
  checks: { name: string; state: CheckState }[];
};

/** An open issue as listed: labels only, no body or comments. */
export type ListedIssue = { number: number; title: string; labels: string[] };

/**
 * phat-mode's own progress labels. They only say what phat-mode is doing; the issue's triage state (ready-for-agent,
 * needs-info, ...) stays with the triage labels.
 */
export const PROGRESS_LABELS = {
  working: { name: 'phat-mode:working', color: 'FBCA04', description: 'phat-mode is working on this' },
  done: { name: 'phat-mode:done', color: '0E8A16', description: 'phat-mode opened a pull request' },
  failed: { name: 'phat-mode:failed', color: 'B60205', description: 'phat-mode could not finish' },
  shaped: { name: 'phat-mode:shaped', color: '5319E7', description: 'phat-mode shaped this into tickets' },
} as const;

/**
 * The progress of a run: one at a time, each replacing the others. `shaped` is not one of them: it stays on a Parent
 * while its Tickets are built.
 */
export const RUN_PROGRESS = ['working', 'done', 'failed'] as const;
export type Progress = (typeof RUN_PROGRESS)[number];

/** A label as phat-mode creates it. */
export type LabelSpec = { name: string; color: string; description: string };

/** How phat-mode creates each triage label (meanings from mattpocock/skills' triage-labels.md), whatever it is named. */
const TRIAGE_STYLES: Record<keyof Labels, Omit<LabelSpec, 'name'>> = {
  needsTriage: { color: 'D876E3', description: 'Maintainer needs to evaluate this issue' },
  needsInfo: { color: 'D93F0B', description: 'Waiting on reporter for more information' },
  readyForAgent: { color: '1D76DB', description: 'Fully specified, ready for an AFK agent' },
  readyForHuman: { color: 'C5DEF5', description: 'Requires human implementation' },
  wontfix: { color: 'FFFFFF', description: 'Will not be actioned' },
  agentMode: { color: 'BFD4F2', description: 'phat-mode shapes this vague issue into tickets' },
};

/**
 * Every label phat-mode needs on a repo: the triage labels (with `agentMode`), as named there, and its progress labels.
 * Each name once: if two roles share a name, the first one's style wins.
 */
export function requiredLabels(labels: Labels): LabelSpec[] {
  const triage = (Object.keys(TRIAGE_STYLES) as (keyof Labels)[]).map((role) => ({ name: labels[role], ...TRIAGE_STYLES[role] }));
  const byName = new Map<string, LabelSpec>();
  for (const label of [...triage, ...Object.values(PROGRESS_LABELS)]) if (!byName.has(label.name)) byName.set(label.name, { ...label });
  return [...byName.values()];
}

/** What `ensureLabels` did: the labels it created, and the ones it could not, with GitHub's reason. */
export type EnsuredLabels = { created: string[]; failed: { name: string; reason: string }[] };

/** The labels phat-mode knows by their default names, for creating one on the fly with its usual style. */
const KNOWN_LABELS = new Map(requiredLabels(DEFAULT_LABELS).map((label) => [label.name, label]));

/** Labels to add and remove. Removing a label that is not there is fine. */
export type LabelChange = { add?: readonly string[]; remove?: readonly string[] };

/** Everything phat-mode does on GitHub. Pipeline code calls these, never the model. */
export interface GitHub {
  /** The issue with its labels and comments. */
  getIssue(issue: number): Promise<Issue>;
  /** Replace an issue's body. */
  editIssueBody(issue: number, body: string): Promise<void>;
  /** Post a comment, or update phat-mode's own one carrying `marker`, so a rerun never posts twice. */
  upsertComment(issue: number, marker: string, body: string): Promise<void>;
  /** The open pull request from `branch` in the repo itself (never a fork's), if any. */
  findPullRequest(branch: string): Promise<PullRequest | undefined>;
  /** The newest pull request from `branch` in the repo itself (never a fork's), in any state. */
  latestPullRequest(branch: string): Promise<(PullRequest & { state: PullRequestState }) | undefined>;
  /** Every open pull request from a branch in the repo itself (never a fork's), with that branch. */
  openPullRequests(): Promise<(PullRequest & { branch: string })[]>;
  /** Open issues labelled `label`, lowest number first. */
  listOpenIssues(label: string): Promise<ListedIssue[]>;
  /** Opens a pull request ready for review (not a draft). */
  createPullRequest(options: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  /** Turns a draft pull request into one ready for review. */
  markReadyForReview(pr: number): Promise<void>;
  updatePullRequestBody(pr: number, body: string): Promise<void>;
  /** Change labels on an issue or pull request. Missing labels are created; existing ones are never edited. */
  editLabels(number: number, change: LabelChange): Promise<void>;
  /** Which of `mentioned`, and of the issue's native "blocked by" dependencies, are still open. */
  openBlockers(issue: number, mentioned: readonly number[]): Promise<number[]>;
  /** The issue's native parent (sub-issues), if it has one. */
  parentIssue(issue: number): Promise<number | undefined>;
  /** A pull request's description, head commit and the checks on it. */
  pullRequestStatus(pr: number): Promise<PullRequestStatus>;
  /**
   * Squash-merge the pull request and delete its branch, only if its head is still `sha`. Never bypasses branch
   * protection. Throws with GitHub's reason when it refuses.
   */
  mergePullRequest(pr: number, sha: string): Promise<void>;
  commentOnPullRequest(pr: number, body: string): Promise<void>;
  /** Open an issue; returns its number. */
  createIssue(options: { title: string; body: string }): Promise<number>;
  /**
   * An issue (never a pull request) whose body carries `marker`, among the issues opened by the `gh` user only: on a
   * public repo anyone can open one carrying the marker.
   */
  findIssueByMarker(marker: string): Promise<number | undefined>;
  /** Make `child` a native sub-issue of `parent`. Nothing happens if it already is. */
  addSubIssue(parent: number, child: number): Promise<void>;
  /** Add a native "blocked by" dependency: `issue` is blocked by `blocker`. Nothing happens if it already is. */
  addBlockedBy(issue: number, blocker: number): Promise<void>;
  /** The issue's native sub-issues, with their state, lowest number first. */
  listSubIssues(parent: number): Promise<SubIssue[]>;
  /**
   * Close an issue as completed, with phat-mode's comment carrying `marker`. The comment goes first and is upserted,
   * so closing again after a crash never posts it twice.
   */
  closeIssue(issue: number, marker: string, body: string): Promise<void>;
}

/** A native sub-issue as listed under its parent. */
export type SubIssue = { number: number; title: string; state: 'OPEN' | 'CLOSED' };

/** Hidden marker that identifies a phat-mode comment. */
export const commentMarker = (key: string) => `<!-- phat-mode:${key} -->`;

/** The label change that shows `progress` (or no progress label at all) and removes the other progress labels. */
export function progressChange(progress: Progress | null): Required<LabelChange> {
  const all = RUN_PROGRESS.map((key) => PROGRESS_LABELS[key].name);
  const add = progress === null ? [] : [PROGRESS_LABELS[progress].name];
  return { add, remove: all.filter((name) => !add.includes(name)) };
}

/** Merge label changes; a label both added and removed is added. */
export function mergeLabels(...changes: LabelChange[]): Required<LabelChange> {
  const add = [...new Set(changes.flatMap((change) => change.add ?? []))];
  const remove = [...new Set(changes.flatMap((change) => change.remove ?? []))].filter((name) => !add.includes(name));
  return { add, remove };
}

/** Fields asked for on pull requests: what `PullRequest` needs, and whether the branch comes from a fork. */
const PR_FIELDS = 'number,url,isDraft,isCrossRepository';

/** One entry of a pull request's `statusCheckRollup`: a check run, or a commit status. */
type RolledUpCheck =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string }
  | { __typename: 'StatusContext'; context: string; state: string };

const PASSED_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

function checkState(check: RolledUpCheck): { name: string; state: CheckState } {
  if (check.__typename === 'CheckRun') {
    const state = check.status !== 'COMPLETED' ? 'running' : PASSED_CONCLUSIONS.includes(check.conclusion) ? 'passed' : 'failed';
    return { name: check.name, state };
  }
  const state = check.state === 'SUCCESS' ? 'passed' : ['PENDING', 'EXPECTED'].includes(check.state) ? 'running' : 'failed';
  return { name: check.context, state };
}

/**
 * The pull requests whose branch is in the repo itself. On a public repo anyone can open one from a fork, and name its
 * branch `phat-mode/issue-N`; only people with write access can push a branch to the repo, so a fork's pull request is
 * never phat-mode's.
 */
const fromRepo = <T extends { isCrossRepository: boolean }>(prs: T[]): Omit<T, 'isCrossRepository'>[] =>
  prs.filter((pr) => !pr.isCrossRepository).map(({ isCrossRepository: _fork, ...pr }) => pr);

/** GitHub through the `gh` CLI, using its existing login. */
export class GhGitHub implements GitHub {
  readonly #repo: string;
  #knownLabels: Set<string> | undefined;
  #viewer: Promise<string> | undefined;

  constructor(repo: string) {
    this.#repo = repo;
  }

  async #gh(args: string[], input?: string): Promise<string> {
    return (await run('gh', args, { input })).stdout;
  }

  async getIssue(issue: number): Promise<Issue> {
    const raw = JSON.parse(
      await this.#gh([
        'issue', 'view', String(issue), '-R', this.#repo,
        '--json', 'number,title,body,author,state,url,labels,comments',
      ]),
    ) as {
      number: number;
      title: string;
      body: string;
      author: { login: string };
      state: 'OPEN' | 'CLOSED';
      url: string;
      labels: { name: string }[];
      comments: { author: { login: string } | null; body: string; createdAt: string }[];
    };
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      author: raw.author.login,
      state: raw.state,
      url: raw.url,
      labels: raw.labels.map((label) => label.name),
      comments: raw.comments.map((comment) => ({
        author: comment.author?.login ?? 'ghost',
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    };
  }

  /** The `gh` user: who phat-mode posts as. */
  #me(): Promise<string> {
    this.#viewer ??= this.#gh(['api', 'user', '--jq', '.login']).then((login) => login.trim());
    return this.#viewer;
  }

  async upsertComment(issue: number, marker: string, body: string): Promise<void> {
    const text = `${marker}\n${body}`;
    const comments = JSON.parse(
      await this.#gh(['api', '--paginate', '--slurp', `repos/${this.#repo}/issues/${issue}/comments`]),
    ) as { id: number; body: string; user: { login: string } | null }[][];
    // Only phat-mode's own comment: anyone can post one carrying the marker on a public repo.
    const me = await this.#me();
    const existing = comments.flat().find((comment) => comment.user?.login === me && comment.body.includes(marker));
    if (existing === undefined) {
      await this.#gh(['issue', 'comment', String(issue), '-R', this.#repo, '--body-file', '-'], text);
    } else if (existing.body !== text) {
      await this.#gh(
        ['api', '--method', 'PATCH', `repos/${this.#repo}/issues/comments/${existing.id}`, '--input', '-'],
        JSON.stringify({ body: text }),
      );
    }
  }

  async editIssueBody(issue: number, body: string): Promise<void> {
    await this.#gh(['issue', 'edit', String(issue), '-R', this.#repo, '--body-file', '-'], body);
  }

  async findPullRequest(branch: string): Promise<PullRequest | undefined> {
    const prs = JSON.parse(
      await this.#gh(['pr', 'list', '-R', this.#repo, '--head', branch, '--state', 'open', '--json', PR_FIELDS]),
    ) as (PullRequest & { isCrossRepository: boolean })[];
    return fromRepo(prs)[0];
  }

  async latestPullRequest(branch: string) {
    const prs = JSON.parse(
      await this.#gh([
        'pr', 'list', '-R', this.#repo, '--head', branch, '--state', 'all', '--limit', '100',
        '--json', `${PR_FIELDS},state`,
      ]),
    ) as (PullRequest & { state: PullRequestState; isCrossRepository: boolean })[];
    return fromRepo(prs).sort((a, b) => b.number - a.number)[0];
  }

  async openPullRequests() {
    const prs = JSON.parse(
      await this.#gh([
        'pr', 'list', '-R', this.#repo, '--state', 'open', '--limit', '500', '--json', `${PR_FIELDS},headRefName`,
      ]),
    ) as (PullRequest & { headRefName: string; isCrossRepository: boolean })[];
    return fromRepo(prs).map(({ headRefName, ...pr }) => ({ ...pr, branch: headRefName }));
  }

  async listOpenIssues(label: string): Promise<ListedIssue[]> {
    const issues = JSON.parse(
      await this.#gh([
        'issue', 'list', '-R', this.#repo, '--state', 'open', '--label', label, '--limit', '500',
        '--json', 'number,title,labels',
      ]),
    ) as { number: number; title: string; labels: { name: string }[] }[];
    return issues
      .map((issue) => ({ number: issue.number, title: issue.title, labels: issue.labels.map((l) => l.name) }))
      .sort((a, b) => a.number - b.number);
  }

  async markReadyForReview(pr: number): Promise<void> {
    await this.#gh(['pr', 'ready', String(pr), '-R', this.#repo]);
  }

  async createPullRequest(options: { branch: string; base: string; title: string; body: string }) {
    await this.#gh(
      [
        'pr', 'create', '-R', this.#repo,
        '--base', options.base, '--head', options.branch,
        '--title', options.title, '--body-file', '-',
      ],
      options.body,
    );
    const pr = await this.findPullRequest(options.branch);
    if (pr === undefined) throw new Error(`Created a pull request for ${options.branch} but cannot find it`);
    return pr;
  }

  async updatePullRequestBody(pr: number, body: string): Promise<void> {
    await this.#gh(['pr', 'edit', String(pr), '-R', this.#repo, '--body-file', '-'], body);
  }

  async pullRequestStatus(pr: number): Promise<PullRequestStatus> {
    const raw = JSON.parse(
      await this.#gh(['pr', 'view', String(pr), '-R', this.#repo, '--json', 'body,headRefOid,commits,statusCheckRollup']),
    ) as {
      body: string;
      headRefOid: string;
      commits: { oid: string; committedDate: string }[];
      statusCheckRollup: RolledUpCheck[] | null;
    };
    const head = raw.commits.find((commit) => commit.oid === raw.headRefOid) ?? raw.commits.at(-1);
    if (head === undefined) throw new Error(`Pull request #${pr} has no commits`);
    return {
      body: raw.body,
      head: { sha: raw.headRefOid, committedAt: head.committedDate },
      checks: (raw.statusCheckRollup ?? []).map(checkState),
    };
  }

  async mergePullRequest(pr: number, sha: string): Promise<void> {
    await this.#gh(['pr', 'merge', String(pr), '-R', this.#repo, '--squash', '--delete-branch', '--match-head-commit', sha]);
  }

  async commentOnPullRequest(pr: number, body: string): Promise<void> {
    await this.#gh(['pr', 'comment', String(pr), '-R', this.#repo, '--body-file', '-'], body);
  }

  async createIssue(options: { title: string; body: string }): Promise<number> {
    const output = await this.#gh(
      ['api', '--method', 'POST', `repos/${this.#repo}/issues`, '--input', '-', '--jq', '.number'],
      JSON.stringify({ title: options.title, body: options.body }),
    );
    const number = Number(output.trim());
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Created the issue "${options.title}" but GitHub gave no number`);
    return number;
  }

  async findIssueByMarker(marker: string): Promise<number | undefined> {
    const me = await this.#me();
    const pages = JSON.parse(
      await this.#gh([
        'api', '--paginate', '--slurp',
        `repos/${this.#repo}/issues?state=all&creator=${encodeURIComponent(me)}&per_page=100`,
      ]),
    ) as { number: number; body: string | null; user: { login: string } | null; pull_request?: unknown }[][];
    // The creator is checked here too: only an issue the gh user opened is ever phat-mode's.
    return pages
      .flat()
      .filter((issue) => issue.pull_request === undefined && issue.user?.login === me && (issue.body ?? '').includes(marker))
      .map((issue) => issue.number)
      .sort((a, b) => a - b)[0];
  }

  /** An issue's database id, which the sub-issue and dependency APIs take (not its number or node id). */
  async #databaseId(issue: number): Promise<number> {
    const id = Number((await this.#gh(['api', `repos/${this.#repo}/issues/${issue}`, '--jq', '.id'])).trim());
    if (!Number.isInteger(id) || id <= 0) throw new Error(`No database id for issue #${issue}`);
    return id;
  }

  async addSubIssue(parent: number, child: number): Promise<void> {
    // GitHub refuses to link a sub-issue twice.
    if ((await this.parentIssue(child)) === parent) return;
    const id = await this.#databaseId(child);
    // -F: the id is sent as an integer.
    await this.#gh(['api', '--method', 'POST', `repos/${this.#repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${id}`]);
  }

  async addBlockedBy(issue: number, blocker: number): Promise<void> {
    const path = `repos/${this.#repo}/issues/${issue}/dependencies/blocked_by`;
    const existing = JSON.parse(await this.#gh(['api', path])) as { number: number }[];
    if (existing.some((candidate) => candidate.number === blocker)) return;
    const id = await this.#databaseId(blocker);
    await this.#gh(['api', '--method', 'POST', path, '-F', `issue_id=${id}`]);
  }

  async listSubIssues(parent: number): Promise<SubIssue[]> {
    const pages = JSON.parse(
      await this.#gh(['api', '--paginate', '--slurp', `repos/${this.#repo}/issues/${parent}/sub_issues?per_page=100`]),
    ) as { number: number; title: string; state: string }[][];
    return pages
      .flat()
      .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state === 'closed' ? ('CLOSED' as const) : ('OPEN' as const) }))
      .sort((a, b) => a.number - b.number);
  }

  async closeIssue(issue: number, marker: string, body: string): Promise<void> {
    await this.upsertComment(issue, marker, body);
    await this.#gh(['issue', 'close', String(issue), '-R', this.#repo, '--reason', 'completed']);
  }

  /** Create the labels that are missing (never edit existing ones). Says which it created and which it could not. */
  async ensureLabels(labels: readonly LabelSpec[]): Promise<EnsuredLabels> {
    const result: EnsuredLabels = { created: [], failed: [] };
    for (const label of labels) {
      const outcome = await this.#createLabel(label);
      if (outcome === 'created') result.created.push(label.name);
      else if (outcome !== 'exists') result.failed.push({ name: label.name, reason: outcome.failed });
    }
    return result;
  }

  /** Create a label unless the repo has it. A label that cannot be created stays missing, so a later call tries again. */
  async #createLabel({ name, color, description }: { name: string } & Partial<LabelSpec>): Promise<'created' | 'exists' | { failed: string }> {
    const known = await this.#loadKnownLabels();
    if (known.has(name)) return 'exists';
    // Create only. Never --force: that would overwrite the colour and description someone else chose.
    const args = ['label', 'create', name, '-R', this.#repo];
    if (color !== undefined) args.push('--color', color);
    if (description !== undefined) args.push('--description', description);
    const result = await run('gh', args, { allowFailure: true });
    const reason = (result.stderr || result.stdout).trim();
    // Already there (the list stops at 1000 labels, or someone just made it): nothing to do.
    if (result.code !== 0 && !/already exists/i.test(reason)) return { failed: reason || `gh exited with ${result.code}` };
    known.add(name);
    return result.code === 0 ? 'created' : 'exists';
  }

  /** Which of `names` the repo does not have. */
  async missingLabels(names: readonly string[]): Promise<string[]> {
    const known = await this.#loadKnownLabels();
    return names.filter((name) => !known.has(name));
  }

  async #loadKnownLabels(): Promise<Set<string>> {
    if (this.#knownLabels === undefined) {
      const labels = JSON.parse(
        await this.#gh(['label', 'list', '-R', this.#repo, '--limit', '1000', '--json', 'name']),
      ) as { name: string }[];
      this.#knownLabels = new Set(labels.map((label) => label.name));
    }
    return this.#knownLabels;
  }

  async openBlockers(issue: number, mentioned: readonly number[]): Promise<number[]> {
    const open = new Set<number>();
    // GitHub's native issue dependencies.
    const native = await run('gh', ['api', `repos/${this.#repo}/issues/${issue}/dependencies/blocked_by`], { allowFailure: true });
    if (native.code === 0) {
      for (const blocker of JSON.parse(native.stdout) as { number: number; state: string }[]) {
        if (blocker.state === 'open') open.add(blocker.number);
      }
    }
    // "Blocked by" references written in the issue or brief.
    for (const number of mentioned) {
      if (open.has(number)) continue;
      const result = await run('gh', ['api', `repos/${this.#repo}/issues/${number}`, '--jq', '.state'], { allowFailure: true });
      // A reference that does not resolve cannot block.
      if (result.code === 0 && result.stdout.trim() === 'open') open.add(number);
    }
    return [...open].sort((a, b) => a - b);
  }

  async parentIssue(issue: number): Promise<number | undefined> {
    // 404 when the issue has no parent.
    const result = await run('gh', ['api', `repos/${this.#repo}/issues/${issue}/parent`, '--jq', '.number'], {
      allowFailure: true,
    });
    const number = Number(result.stdout.trim());
    return result.code === 0 && Number.isInteger(number) && number > 0 ? number : undefined;
  }

  async editLabels(number: number, change: LabelChange): Promise<void> {
    // The issues label API works for pull requests too.
    const current = JSON.parse(await this.#gh(['api', `repos/${this.#repo}/issues/${number}/labels`])) as { name: string }[];
    const names = new Set(current.map((label) => label.name));
    const add = (change.add ?? []).filter((name) => !names.has(name));
    const remove = (change.remove ?? []).filter((name) => names.has(name) && !(change.add ?? []).includes(name));
    // Styled as phat-mode would on init, if it knows the name; adding the label below reports any real failure.
    for (const name of add) await this.#createLabel(KNOWN_LABELS.get(name) ?? { name });
    if (add.length > 0) {
      await this.#gh(['api', '--method', 'POST', `repos/${this.#repo}/issues/${number}/labels`, '--input', '-'], JSON.stringify({ labels: add }));
    }
    for (const name of remove) {
      await this.#gh(['api', '--method', 'DELETE', `repos/${this.#repo}/issues/${number}/labels/${encodeURIComponent(name)}`]);
    }
  }
}
