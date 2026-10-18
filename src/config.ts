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
  /** Only issues opened by these GitHub users are worked on. */
  allowedAuthors: string[];
  /** Runs once in a fresh workspace. */
  installCommand: string;
  /** Must exit 0 before a pull request is opened. */
  checkCommand: string;
  models: {
    triage: ModelChoice;
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
    models: {
      triage: { provider: 'github-copilot', modelId: 'claude-sonnet-5.5', thinkingLevel: 'medium' },
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
    models: { ...config.models, ...overrides.models },
    limits: { ...config.limits, ...overrides.limits },
    home,
  };
}

export const paths = {
  state: (config: Config) => join(config.home, 'state.sqlite'),
  credentials: (config: Config) => join(config.home, 'auth.json'),
  repoClone: (config: Config) => join(config.home, 'repos', config.repo.replace('/', '__')),
  workspace: (config: Config, issue: number) =>
    join(config.home, 'workspaces', config.repo.replace('/', '__'), `issue-${issue}`),
};

export const branchFor = (issue: number) => `phat-mode/issue-${issue}`;
