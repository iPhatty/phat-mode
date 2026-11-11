import { branchFor, type Config, defaultMachineConfig, repoConfig } from '../src/config.ts';
import type { CommitChecks, GitHub, Issue, LabelChange, PullRequest, PullRequestState, PullRequestStatus, SubIssue } from '../src/github.ts';

/** What a test sets of a pull request's status: its head and checks; mergeability and reviews when they matter. */
export type FakeStatus = Omit<PullRequestStatus, 'body' | 'labels' | 'mergeable' | 'mergeState' | 'reviews'> &
  Partial<Pick<PullRequestStatus, 'mergeable' | 'mergeState' | 'reviews'>>;

/** A repo's full settings, as phat-mode would build them from a .phat-mode.json with npm commands. */
export const testConfig = (home: string, repo = 'test/repo', settings: Partial<Config> = {}): Config => ({
  ...repoConfig(
    defaultMachineConfig(home),
    repo,
    { installCommand: 'npm ci', checkCommand: 'npm run check' },
    { defaultBranch: 'main', viewer: 'iPhatty' },
  ),
  ...settings,
});

/** GitHub in memory. */
export class FakeGitHub implements GitHub {
  issues = new Map<number, Issue>();
  /** `author`: the `gh` user (`viewer`) unless a test adds someone else's; `createdAt`: in the order they were posted. */
  comments: { issue: number; marker: string; body: string; author: string; createdAt: string }[] = [];
  #posted = 0;
  #now() {
    return new Date(Date.UTC(2026, 0, 2) + 1_000 * this.#posted++).toISOString();
  }
  /** Someone else's comment, e.g. one forging phat-mode's marker. */
  addComment(issue: number, body: string, author = 'stranger') {
    this.comments.push({ issue, marker: '', body, author, createdAt: this.#now() });
  }
  async phatModeComments(number: number) {
    return this.comments
      .filter((comment) => comment.issue === number && comment.author === this.viewer)
      .map((comment) => ({ body: comment.marker === '' ? comment.body : `${comment.marker}\n${comment.body}`, createdAt: comment.createdAt }));
  }
  /** Every call that changes something on GitHub. */
  writes = 0;
  prs: (PullRequest & {
    branch: string;
    base: string;
    title: string;
    body: string;
    labels: string[];
    state: PullRequestState;
  })[] = [];
  readied: number[] = [];
  /** Native parents: issue → parent. */
  parents = new Map<number, number>();
  async parentIssue(issue: number) {
    return this.parents.get(issue);
  }
  /** Head commit and checks, by pull request number; mergeable and clean, with no reviews, unless a test says otherwise. */
  statuses = new Map<number, FakeStatus>();
  async pullRequestStatus(number: number): Promise<PullRequestStatus> {
    const pr = this.prs.find((candidate) => candidate.number === number)!;
    const status = this.statuses.get(number) ?? { head: { sha: 'unknown', committedAt: '1970-01-01T00:00:00Z' }, checks: [] };
    return structuredClone({ mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviews: [], ...status, labels: [...pr.labels], body: pr.body });
  }
  /** Merges done, and pull requests GitHub refuses to merge, with its reason. */
  merges: { pr: number; sha: string }[] = [];
  refuseMerge = new Map<number, string>();
  async mergePullRequest(number: number, sha: string) {
    const refused = this.refuseMerge.get(number);
    if (refused !== undefined) throw new Error(`gh pr merge exited with 1: ${refused}`);
    if (this.statuses.get(number)?.mergeable === 'CONFLICTING') throw new Error('gh pr merge exited with 1: Pull request is not mergeable');
    const head = this.statuses.get(number)?.head.sha;
    if (head !== sha) throw new Error(`gh pr merge exited with 1: head is ${head}, not ${sha}`);
    this.writes++;
    this.merges.push({ pr: number, sha });
    this.prs.find((pr) => pr.number === number)!.state = 'MERGED';
  }
  prComments: { pr: number; body: string }[] = [];
  async commentOnPullRequest(pr: number, body: string) {
    this.writes++;
    this.prComments.push({ pr, body });
  }

  /** The `gh` user: who phat-mode posts and opens issues as. */
  viewer = 'iPhatty';
  /** Native "blocked by" edges added, in order. */
  blockedByEdges: { issue: number; blocker: number }[] = [];
  /** Issues phat-mode opened, in order. */
  created: number[] = [];
  async createIssue(options: { title: string; body: string }) {
    this.writes++;
    const number = Math.max(0, ...this.issues.keys(), ...this.prs.map((pr) => pr.number)) + 1;
    this.addIssue(number, { ...options, author: this.viewer, labels: [] });
    this.created.push(number);
    return number;
  }
  async findIssueByMarker(marker: string) {
    return [...this.issues.values()]
      .filter((issue) => issue.author === this.viewer && issue.body.includes(marker))
      .map((issue) => issue.number)
      .sort((a, b) => a - b)[0];
  }
  async addSubIssue(parent: number, child: number) {
    this.writes++;
    this.parents.set(child, parent);
  }
  async addBlockedBy(issue: number, blocker: number) {
    this.writes++;
    const native = this.native.get(issue) ?? [];
    if (native.includes(blocker)) return;
    this.native.set(issue, [...native, blocker]);
    this.blockedByEdges.push({ issue, blocker });
  }
  async listSubIssues(parent: number): Promise<SubIssue[]> {
    return [...this.parents.entries()]
      .filter(([, of]) => of === parent)
      .map(([child]) => this.issues.get(child)!)
      .map(({ number, title, state }) => ({ number, title, state }))
      .sort((a, b) => a.number - b.number);
  }
  /** Issues phat-mode closed, in order. */
  closed: number[] = [];
  async closeIssue(number: number, marker: string, body: string) {
    await this.upsertComment(number, marker, body);
    this.writes++;
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    issue.state = 'CLOSED';
    this.openIssues.delete(number);
    this.closed.push(number);
  }

  addIssue(number: number, fields: Partial<Issue> = {}) {
    this.issues.set(number, {
      number,
      title: `Issue ${number}`,
      body: 'Add a hello file.',
      author: 'iPhatty',
      state: 'OPEN',
      url: `https://github.test/issues/${number}`,
      labels: ['enhancement', 'ready-for-agent'],
      comments: [],
      ...fields,
      // A fixed past time: everything committed in a test comes after it.
      createdAt: fields.createdAt ?? '2026-01-01T00:00:00Z',
    });
  }
  labels(number: number) {
    return [...(this.issues.get(number)?.labels ?? this.prs.find((pr) => pr.number === number)!.labels)].sort();
  }
  async getIssue(number: number) {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return structuredClone(issue);
  }
  async editIssueBody(number: number, body: string) {
    this.writes++;
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    issue.body = body;
  }
  async upsertComment(issue: number, marker: string, body: string) {
    this.writes++;
    const existing = this.comments.find((comment) => comment.issue === issue && comment.marker === marker && comment.author === this.viewer);
    if (existing) existing.body = body;
    else this.comments.push({ issue, marker, body, author: this.viewer, createdAt: this.#now() });
  }
  async findPullRequest(branch: string) {
    return this.prs.find((pr) => pr.branch === branch && pr.state === 'OPEN');
  }
  async latestPullRequest(branch: string) {
    return this.prs.filter((pr) => pr.branch === branch).at(-1);
  }
  async openPullRequests() {
    return this.prs.filter((pr) => pr.state === 'OPEN');
  }
  async listOpenIssues(label: string) {
    return [...this.issues.values()]
      .filter((issue) => issue.state === 'OPEN' && issue.labels.includes(label))
      .map(({ number, title, labels }) => ({ number, title, labels: [...labels] }))
      .sort((a, b) => a.number - b.number);
  }
  /** A pull request as phat-mode, or a person, opened it. */
  addPullRequest(options: { branch: string; state?: PullRequestState; isDraft?: boolean }) {
    // Numbers apart from issues, as on GitHub they share one sequence.
    const number = 100 + this.prs.length;
    const pr = {
      number,
      url: `https://github.test/pull/${number}`,
      labels: [],
      base: 'main',
      title: `PR ${number}`,
      body: '',
      state: 'OPEN' as const,
      isDraft: false,
      ...options,
    };
    this.prs.push(pr);
    return pr;
  }
  async createPullRequest(options: { branch: string; base: string; title: string; body: string }) {
    this.writes++;
    const pr = this.addPullRequest({ branch: options.branch });
    Object.assign(pr, options);
    return pr;
  }
  async markReadyForReview(number: number) {
    this.writes++;
    this.readied.push(number);
    this.prs.find((pr) => pr.number === number)!.isDraft = false;
  }
  async updatePullRequestBody(number: number, body: string) {
    this.writes++;
    this.prs.find((pr) => pr.number === number)!.body = body;
  }
  /** Issue numbers that count as open blockers. */
  openIssues = new Set<number>();
  native = new Map<number, number[]>();
  async openBlockers(issue: number, mentioned: readonly number[]) {
    return [...new Set([...(this.native.get(issue) ?? []), ...mentioned])]
      .filter((n) => this.openIssues.has(n))
      // As the real one: a blocker whose phat-mode pull request has merged is finished, however long GitHub takes to close its issue.
      .filter((n) => this.prs.filter((pr) => pr.branch === branchFor(n)).at(-1)?.state !== 'MERGED')
      .sort();
  }
  /** Commits by ref (a branch name or a sha): the sha it is at and its checks. Any other ref is a commit with no checks. */
  commits = new Map<string, CommitChecks>();
  async commitChecks(ref: string) {
    return structuredClone(this.commits.get(ref) ?? { sha: ref, checks: [] });
  }
  /** Actions job logs, by job id; a job without one fails to fetch, as GitHub does once logs expire. */
  jobLogs = new Map<number, string>();
  async jobLog(jobId: number) {
    const log = this.jobLogs.get(jobId);
    if (log === undefined) throw new Error(`gh api exited with 1: HTTP 410: Gone (job ${jobId})`);
    return log;
  }
  /** Workflow runs whose failed jobs were rerun, in order. */
  reruns: number[] = [];
  async rerunFailedJobs(runId: number) {
    this.writes++;
    this.reruns.push(runId);
    this.runAttempts.set(runId, (this.runAttempts.get(runId) ?? 1) + 1);
  }
  /** Workflow runs' attempts, by run id: 1 unless rerun. */
  runAttempts = new Map<number, number>();
  async runAttempt(runId: number) {
    return this.runAttempts.get(runId) ?? 1;
  }
  async editLabels(number: number, change: LabelChange) {
    this.writes++;
    const target = this.issues.get(number) ?? this.prs.find((pr) => pr.number === number)!;
    const add = change.add ?? [];
    target.labels = [
      ...target.labels.filter((label) => !(change.remove ?? []).includes(label) || add.includes(label)),
      ...add.filter((label) => !target.labels.includes(label)),
    ];
  }
}
