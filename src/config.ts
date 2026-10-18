import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ModelChoice = {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

export type Config = {
  /** GitHub repository, "owner/name". */
  repo: string;
  /** Branch pull requests target. */
  baseBranch: string;
  /**
   * GitHub users phat-mode trusts. Their Agent Briefs are used as the spec; an issue without a brief is only worked on
   * when one of them opened it.
   */
  allowedAuthors: string[];
  /**
   * Triage labels, as mapped in the repo's triage-labels.md (mattpocock/skills). phat-mode only works on issues labelled
   * `readyForAgent`, and hands issues back with `needsInfo` or `readyForHuman`.
   */
  labels: {
    needsTriage: string;
    needsInfo: string;
    readyForAgent: string;
    readyForHuman: string;
    wontfix: string;
  };
  /** Runs once in a fresh workspace. */
  installCommand: string;
  /** Must exit 0 before a pull request is opened. */
  checkCommand: string;
  models: {
    plan: ModelChoice;
    implement: ModelChoice;
    review: ModelChoice;
  };
  limits: {
    /** Times the implementer may try to fix failing checks. */
    maxCheckFixes: number;
    /** Review rounds before the PR is opened with any remaining findings listed. */
    maxReviewRounds: number;
    /** Hard cap on implementer runs per issue. */
    maxImplementRuns: number;
    checkTimeoutMs: number;
    installTimeoutMs: number;
  };
  /** Where phat-mode keeps its state, credentials and workspaces. */
  home: string;
};

export const DEFAULT_HOME = process.env.PHAT_MODE_HOME ?? join(homedir(), '.phat-mode');

export function defaultConfig(home = DEFAULT_HOME): Config {
  return {
    repo: 'iPhatty/phatty-lingo',
    baseBranch: 'main',
    allowedAuthors: ['iPhatty'],
    installCommand: 'npm ci',
    checkCommand: 'npm run check',
    labels: {
      needsTriage: 'needs-triage',
      needsInfo: 'needs-info',
      readyForAgent: 'ready-for-agent',
      readyForHuman: 'ready-for-human',
      wontfix: 'wontfix',
    },
    models: {
      plan: { provider: 'github-copilot', modelId: 'claude-sonnet-5.5', thinkingLevel: 'medium' },
      implement: { provider: 'github-copilot', modelId: 'claude-sonnet-5.5', thinkingLevel: 'medium' },
      review: { provider: 'github-copilot', modelId: 'gpt-6.1-sol', thinkingLevel: 'medium' },
    },
    limits: {
      maxCheckFixes: 3,
      maxReviewRounds: 2,
      maxImplementRuns: 8,
      checkTimeoutMs: 10 * 60_000,
      installTimeoutMs: 15 * 60_000,
    },
    home,
  };
}

/** Defaults, overridden by `<home>/config.json` when it exists. */
export async function loadConfig(home = DEFAULT_HOME): Promise<Config> {
  const config = defaultConfig(home);
  let text: string;
  try {
    text = await readFile(join(home, 'config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw error;
  }
  const overrides = JSON.parse(text) as Partial<Config>;
  return {
    ...config,
    ...overrides,
    labels: { ...config.labels, ...overrides.labels },
    models: { ...config.models, ...overrides.models },
    limits: { ...config.limits, ...overrides.limits },
    home,
  };
}

export const paths = {
  state: (config: Config) => join(config.home, 'state.sqlite'),
  lock: (config: Config) => join(config.home, 'state.sqlite.lock'),
  credentials: (config: Config) => join(config.home, 'auth.json'),
  repoClone: (config: Config) => join(config.home, 'repos', config.repo.replace('/', '__')),
  workspace: (config: Config, issue: number) =>
    join(config.home, 'workspaces', config.repo.replace('/', '__'), `issue-${issue}`),
};

export const branchFor = (issue: number) => `phat-mode/issue-${issue}`;
