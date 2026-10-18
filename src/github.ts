import { run } from './exec.ts';

export type Issue = {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: string[];
};

export type PullRequest = {
  number: number;
  url: string;
};

/** Labels phat-mode uses to show where an issue is. Only one status label is on an issue at a time. */
export const STATUS_LABELS = {
  working: { name: 'phat-mode:working', color: 'FBCA04', description: 'phat-mode is working on this' },
  done: { name: 'phat-mode:done', color: '0E8A16', description: 'phat-mode opened a pull request' },
  needsInfo: { name: 'phat-mode:needs-info', color: 'D876E3', description: 'phat-mode needs more detail' },
  failed: { name: 'phat-mode:failed', color: 'B60205', description: 'phat-mode could not finish' },
} as const;

export type StatusLabel = keyof typeof STATUS_LABELS;

/** Everything phat-mode does on GitHub. Pipeline code calls these, never the model. */
export interface GitHub {
  getIssue(issue: number): Promise<Issue>;
  /** Post a comment, or update the one carrying `marker`, so a rerun never posts twice. */
  upsertComment(issue: number, marker: string, body: string): Promise<void>;
  /** The open pull request from `branch`, if any. */
  findPullRequest(branch: string): Promise<PullRequest | undefined>;
  createDraftPullRequest(options: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  updatePullRequestBody(pr: number, body: string): Promise<void>;
  setStatus(issue: number, status: StatusLabel): Promise<void>;
}

/** Hidden marker that identifies a phat-mode comment. */
export const commentMarker = (key: string) => `<!-- phat-mode:${key} -->`;

/** GitHub through the `gh` CLI, using its existing login. */
export class GhGitHub implements GitHub {
  readonly #repo: string;
  #labelsReady = false;

  constructor(repo: string) {
    this.#repo = repo;
  }

  async #gh(args: string[], input?: string): Promise<string> {
    return (await run('gh', args, { input })).stdout;
  }

  async getIssue(issue: number): Promise<Issue> {
    const raw = JSON.parse(
      await this.#gh(['issue', 'view', String(issue), '-R', this.#repo, '--json', 'number,title,body,author,state,url,labels']),
    ) as {
      number: number;
      title: string;
      body: string;
      author: { login: string };
      state: 'OPEN' | 'CLOSED';
      url: string;
      labels: { name: string }[];
    };
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      author: raw.author.login,
      state: raw.state,
      url: raw.url,
      labels: raw.labels.map((label) => label.name),
    };
  }

  async upsertComment(issue: number, marker: string, body: string): Promise<void> {
    const text = `${marker}\n${body}`;
    const comments = JSON.parse(
      await this.#gh(['api', '--paginate', '--slurp', `repos/${this.#repo}/issues/${issue}/comments`]),
    ) as { id: number; body: string }[][];
    const existing = comments.flat().find((comment) => comment.body.includes(marker));
    if (existing === undefined) {
      await this.#gh(['issue', 'comment', String(issue), '-R', this.#repo, '--body-file', '-'], text);
    } else if (existing.body !== text) {
      await this.#gh(
        ['api', '--method', 'PATCH', `repos/${this.#repo}/issues/comments/${existing.id}`, '--input', '-'],
        JSON.stringify({ body: text }),
      );
    }
  }

  async findPullRequest(branch: string): Promise<PullRequest | undefined> {
    const prs = JSON.parse(
      await this.#gh(['pr', 'list', '-R', this.#repo, '--head', branch, '--state', 'open', '--json', 'number,url']),
    ) as PullRequest[];
    return prs[0];
  }

  async createDraftPullRequest(options: { branch: string; base: string; title: string; body: string }) {
    await this.#gh(
      [
        'pr', 'create', '-R', this.#repo, '--draft',
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

  async setStatus(issue: number, status: StatusLabel): Promise<void> {
    if (!this.#labelsReady) {
      for (const label of Object.values(STATUS_LABELS)) {
        await this.#gh([
          'label', 'create', label.name, '-R', this.#repo,
          '--color', label.color, '--description', label.description, '--force',
        ]);
      }
      this.#labelsReady = true;
    }
    const current = (await this.getIssue(issue)).labels;
    const wanted = STATUS_LABELS[status].name;
    const remove = Object.values(STATUS_LABELS)
      .map((label) => label.name)
      .filter((name) => name !== wanted && current.includes(name));
    if (current.includes(wanted) && remove.length === 0) return;
    const args = ['issue', 'edit', String(issue), '-R', this.#repo, '--add-label', wanted];
    for (const name of remove) args.push('--remove-label', name);
    await this.#gh(args);
  }
}
