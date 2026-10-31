import {
  type Config,
  isRepoName,
  type MachineConfig,
  parseRepoSettings,
  REPO_SETTINGS_FILE,
  type RepoSettings,
  repoConfig,
} from './config.ts';
import { run } from './exec.ts';

/** The repo has no .phat-mode.json on its default branch yet. */
export class NotSetUpError extends Error {}

/** "owner/name" of the GitHub repo the folder `cwd` is a clone of, if it is one. */
export async function currentRepo(cwd = process.cwd()): Promise<string | undefined> {
  const result = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd,
    allowFailure: true,
  });
  const name = result.stdout.trim();
  return result.code === 0 && isRepoName(name) ? name : undefined;
}

/**
 * An issue, written as `12`, `#12`, `owner/name#12` or its GitHub URL. A bare number means an issue in `here`, the
 * repo of the current folder.
 */
export function parseIssueRef(text: string, here: string | undefined): { repo: string; issue: number } {
  const trimmed = text.trim();
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/.exec(trimmed);
  const full = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(trimmed);
  const bare = /^#?(\d+)$/.exec(trimmed);
  const [repo, number] = url ? [url[1], url[2]] : full ? [full[1], full[2]] : bare ? [here, bare[1]] : [undefined, undefined];
  if (number === undefined) throw new Error(`"${text}" is not an issue: use 12, owner/name#12 or the issue's URL`);
  if (repo === undefined) {
    throw new Error(`#${number}: which repo? Run this inside a clone of it, or write owner/name#${number}`);
  }
  const issue = Number(number);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`"${text}" is not an issue number`);
  return { repo, issue };
}

/** What phat-mode reads from GitHub to set up a repo. */
export type RepoFacts = { defaultBranch: string; viewer: string; settings: RepoSettings };

/** The repo's default branch, the `gh` user, and the repo's .phat-mode.json on that branch (or its `baseBranch`). */
export async function fetchRepoFacts(repo: string): Promise<RepoFacts> {
  const view = await run('gh', ['api', `repos/${repo}`, '--jq', '.default_branch'], { allowFailure: true });
  if (view.code !== 0) throw new Error(`Cannot read ${repo} on GitHub: ${(view.stderr || view.stdout).trim().split('\n')[0]}`);
  const defaultBranch = view.stdout.trim();
  const viewer = (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
  const text = await readRepoFile(repo, REPO_SETTINGS_FILE, defaultBranch);
  if (text === undefined) {
    throw new NotSetUpError(
      `${repo} is not set up for phat-mode: no ${REPO_SETTINGS_FILE} on ${defaultBranch}. Run \`phat-mode init\` in a clone of it, then commit and push the file.`,
    );
  }
  return { defaultBranch, viewer, settings: parseRepoSettings(text, `${repo}: ${REPO_SETTINGS_FILE}`) };
}

/** A file's text on `ref`, or undefined if it is not there. */
async function readRepoFile(repo: string, path: string, ref: string): Promise<string | undefined> {
  const result = await run(
    'gh',
    ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`],
    { allowFailure: true },
  );
  if (result.code === 0) return result.stdout;
  if (/HTTP 404/.test(result.stderr)) return undefined;
  throw new Error(`Cannot read ${path} from ${repo}: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
}

export async function loadRepoConfig(machine: MachineConfig, repo: string): Promise<Config> {
  const facts = await fetchRepoFacts(repo);
  return repoConfig(machine, repo, facts.settings, facts);
}
