import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ModelChoice = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

/** The agents phat-mode runs. */
export type Role = 'plan' | 'implement' | 'review' | 'verify';
export const ROLES: readonly Role[] = ['plan', 'implement', 'review', 'verify'];

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
  /** The model every role uses unless `models` overrides it. */
  defaultModel: ModelChoice;
  /** Per-role overrides of `defaultModel`; any field left out comes from it. */
  models: Partial<Record<Role, Partial<ModelChoice>>>;
  limits: {
    /** Times the implementer may try to fix failing checks. */
    maxCheckFixes: number;
    /** Review rounds before the PR is opened with any remaining findings listed. */
    maxReviewRounds: number;
    /** Verification rounds, counting the first one. */
    maxVerifyRounds: number;
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
    defaultModel: { provider: 'github-copilot', modelId: 'claude-opus-5.5', thinkingLevel: 'medium' },
    models: {
      // A different model family reviews the code, so the review is independent of the model that wrote it.
      review: { provider: 'github-copilot', modelId: 'gpt-6.1-sol' },
    },
    limits: {
      maxCheckFixes: 3,
      maxReviewRounds: 2,
      maxVerifyRounds: 2,
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
  const overrides = JSON.parse(text) as Partial<Omit<Config, 'defaultModel'>> & { defaultModel?: Partial<ModelChoice> };
  return {
    ...config,
    ...overrides,
    labels: { ...config.labels, ...overrides.labels },
    defaultModel: { ...config.defaultModel, ...overrides.defaultModel },
    // `null` for a role drops its built-in override, so it follows defaultModel.
    models: Object.fromEntries(
      ROLES.map((role) => {
        const override = (overrides.models as Record<Role, Partial<ModelChoice> | null> | undefined)?.[role];
        return [role, override === null ? {} : { ...config.models[role], ...override }];
      }),
    ),
    limits: { ...config.limits, ...overrides.limits },
    home,
  };
}

/** The model a role runs with: its override, field by field, over `defaultModel`. */
export function modelFor(config: Pick<Config, 'defaultModel' | 'models'>, role: Role): ModelChoice {
  return { ...config.defaultModel, ...config.models[role] };
}

export const paths = {
  state: (config: Config) => join(config.home, 'state.sqlite'),
  lock: (config: Config) => join(config.home, 'state.sqlite.lock'),
  credentials: (config: Config) => join(config.home, 'auth.json'),
  repoClone: (config: Config) => join(config.home, 'repos', config.repo.replace('/', '__')),
  workspace: (config: Config, issue: number) =>
    join(config.home, 'workspaces', config.repo.replace('/', '__'), `issue-${issue}`),
  /** The base branch checkout, for "before" evidence. */
  baseWorkspace: (config: Config) => join(config.home, 'workspaces', config.repo.replace('/', '__'), 'base'),
  /** phat-mode's copies of verification evidence, kept until published. */
  evidence: (config: Config, issue: number) =>
    join(config.home, 'evidence', config.repo.replace('/', '__'), `issue-${issue}`),
};

export const branchFor = (issue: number) => `phat-mode/issue-${issue}`;
