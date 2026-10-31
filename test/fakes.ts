import { type Config, defaultMachineConfig, repoConfig } from '../src/config.ts';
import type { GitHub, Issue, LabelChange, PullRequest, PullRequestState } from '../src/github.ts';

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
  comments: { issue: number; marker: string; body: string }[] = [];
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
  async upsertComment(issue: number, marker: string, body: string) {
    this.writes++;
    const existing = this.comments.find((comment) => comment.issue === issue && comment.marker === marker);
    if (existing) existing.body = body;
    else this.comments.push({ issue, marker, body });
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
    return [...new Set([...(this.native.get(issue) ?? []), ...mentioned])].filter((n) => this.openIssues.has(n)).sort();
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
