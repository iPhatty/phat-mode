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
};

/**
 * phat-mode's own progress labels. They only say what phat-mode is doing; the issue's triage state (ready-for-agent,
 * needs-info, ...) stays with the triage labels.
 */
export const PROGRESS_LABELS = {
  working: { name: 'phat-mode:working', color: 'FBCA04', description: 'phat-mode is working on this' },
  done: { name: 'phat-mode:done', color: '0E8A16', description: 'phat-mode opened a pull request' },
  failed: { name: 'phat-mode:failed', color: 'B60205', description: 'phat-mode could not finish' },
} as const;

export type Progress = keyof typeof PROGRESS_LABELS;

/** Labels to add and remove. Removing a label that is not there is fine. */
export type LabelChange = { add?: readonly string[]; remove?: readonly string[] };

/** Everything phat-mode does on GitHub. Pipeline code calls these, never the model. */
export interface GitHub {
  /** The issue with its labels and comments. */
  getIssue(issue: number): Promise<Issue>;
  /** Post a comment, or update the one carrying `marker`, so a rerun never posts twice. */
  upsertComment(issue: number, marker: string, body: string): Promise<void>;
  /** The open pull request from `branch`, if any. */
  findPullRequest(branch: string): Promise<PullRequest | undefined>;
  createDraftPullRequest(options: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  updatePullRequestBody(pr: number, body: string): Promise<void>;
  /** Change labels on an issue or pull request. Missing labels are created; existing ones are never edited. */
  editLabels(number: number, change: LabelChange): Promise<void>;
  /** Which of `mentioned`, and of the issue's native "blocked by" dependencies, are still open. */
  openBlockers(issue: number, mentioned: readonly number[]): Promise<number[]>;
}

/** Hidden marker that identifies a phat-mode comment. */
export const commentMarker = (key: string) => `<!-- phat-mode:${key} -->`;

/** The label change that shows `progress` (or no progress label at all) and removes the other progress labels. */
export function progressChange(progress: Progress | null): Required<LabelChange> {
  const all = Object.values(PROGRESS_LABELS).map((label) => label.name);
  const add = progress === null ? [] : [PROGRESS_LABELS[progress].name];
  return { add, remove: all.filter((name) => !add.includes(name)) };
}

/** Merge label changes; a label both added and removed is added. */
export function mergeLabels(...changes: LabelChange[]): Required<LabelChange> {
  const add = [...new Set(changes.flatMap((change) => change.add ?? []))];
  const remove = [...new Set(changes.flatMap((change) => change.remove ?? []))].filter((name) => !add.includes(name));
  return { add, remove };
}

/** GitHub through the `gh` CLI, using its existing login. */
export class GhGitHub implements GitHub {
  readonly #repo: string;
  #knownLabels: Set<string> | undefined;

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

  async #ensureLabel(name: string): Promise<void> {
    if (this.#knownLabels === undefined) {
      const labels = JSON.parse(
        await this.#gh(['label', 'list', '-R', this.#repo, '--limit', '1000', '--json', 'name']),
      ) as { name: string }[];
      this.#knownLabels = new Set(labels.map((label) => label.name));
    }
    if (this.#knownLabels.has(name)) return;
    // Create only. Never --force: that would overwrite the colour and description someone else chose.
    const progress = Object.values(PROGRESS_LABELS).find((label) => label.name === name);
    const args = ['label', 'create', name, '-R', this.#repo];
    if (progress) args.push('--color', progress.color, '--description', progress.description);
    await run('gh', args, { allowFailure: true });
    this.#knownLabels.add(name);
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

  async editLabels(number: number, change: LabelChange): Promise<void> {
    // The issues label API works for pull requests too.
    const current = JSON.parse(await this.#gh(['api', `repos/${this.#repo}/issues/${number}/labels`])) as { name: string }[];
    const names = new Set(current.map((label) => label.name));
    const add = (change.add ?? []).filter((name) => !names.has(name));
    const remove = (change.remove ?? []).filter((name) => names.has(name) && !(change.add ?? []).includes(name));
    for (const name of add) await this.#ensureLabel(name);
    if (add.length > 0) {
      await this.#gh(['api', '--method', 'POST', `repos/${this.#repo}/issues/${number}/labels`, '--input', '-'], JSON.stringify({ labels: add }));
    }
    for (const name of remove) {
      await this.#gh(['api', '--method', 'DELETE', `repos/${this.#repo}/issues/${number}/labels/${encodeURIComponent(name)}`]);
    }
  }
}
