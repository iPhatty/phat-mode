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
export type Role = 'plan' | 'implement' | 'review' | 'verify' | 'grill' | 'shape';
export const ROLES: readonly Role[] = ['plan', 'implement', 'review', 'verify', 'grill', 'shape'];

export type Labels = {
  needsTriage: string;
  needsInfo: string;
  readyForAgent: string;
  readyForHuman: string;
  wontfix: string;
  /** Set by a human on a vague issue: phat-mode shapes it into ready-for-agent tickets instead of building it. */
  agentMode: string;
};

export type Limits = {
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
  /** Grilling rounds when shaping; questions still open after the last one are decided with the recommended answers. */
  maxGrillRounds: number;
  /** Most tickets shaping may break a request into; a bigger request is handed to a human. */
  maxTickets: number;
};

/** Your settings, the same for every repo: `~/.phat-mode/config.json`. */
export type MachineConfig = {
  /** Where phat-mode keeps its state, credentials and workspaces. */
  home: string;
  /** The model every role uses unless `models` overrides it. */
  defaultModel: ModelChoice;
  /** Per-role overrides of `defaultModel`; any field left out comes from it. */
  models: Partial<Record<Role, Partial<ModelChoice>>>;
  limits: Limits;
  /** How often `phat-mode watch` looks at GitHub when it has nothing to do. */
  watchIntervalMs: number;
  /** Repos `phat-mode watch` works on ("owner/name"), when none are named on the command line. */
  repos: string[];
  /** GitHub users trusted on every repo, unless the repo's own settings list them. Default: the `gh` user. */
  allowedAuthors?: string[];
};

/** What each repo decides for itself: `.phat-mode.json` on its default branch, written by `phat-mode init`. */
export type RepoSettings = {
  /** Runs once in a fresh workspace, e.g. `npm ci`. */
  installCommand: string;
  /** Must exit 0 before a pull request is opened, e.g. `npm run check`. */
  checkCommand: string;
  /** Branch pull requests target. Default: the repo's default branch. */
  baseBranch?: string;
  /** Overrides the trusted authors from your config.json for this repo. */
  allowedAuthors?: string[];
  /** Triage label names (and `agentMode`), when the repo maps them differently (see its triage-labels.md). */
  labels?: Partial<Labels>;
};

export const REPO_SETTINGS_FILE = '.phat-mode.json';

/** Everything one run needs: your settings, plus the repo's. */
export type Config = Omit<MachineConfig, 'repos' | 'allowedAuthors'> & {
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
  labels: Labels;
  installCommand: string;
  checkCommand: string;
};

export const DEFAULT_HOME = process.env.PHAT_MODE_HOME ?? join(homedir(), '.phat-mode');

export const DEFAULT_LABELS: Labels = {
  needsTriage: 'needs-triage',
  needsInfo: 'needs-info',
  readyForAgent: 'ready-for-agent',
  readyForHuman: 'ready-for-human',
  wontfix: 'wontfix',
  agentMode: 'agent-mode',
};

export function defaultMachineConfig(home = DEFAULT_HOME): MachineConfig {
  return {
    home,
    defaultModel: { provider: 'github-copilot', modelId: 'claude-opus-5.5', thinkingLevel: 'medium' },
    models: {
      // A different model family reviews the code, so the review is independent of the model that wrote it.
      review: { provider: 'github-copilot', modelId: 'gpt-6.1-sol' },
      // The questioner in shaping, on a different model family from the answerer (`shape`, defaultModel).
      grill: { provider: 'github-copilot', modelId: 'gpt-6.1-sol' },
    },
    limits: {
      maxCheckFixes: 3,
      maxReviewRounds: 2,
      maxVerifyRounds: 2,
      maxImplementRuns: 8,
      checkTimeoutMs: 10 * 60_000,
      installTimeoutMs: 15 * 60_000,
      maxGrillRounds: 6,
      maxTickets: 8,
    },
    watchIntervalMs: 2 * 60_000,
    repos: [],
  };
}

/** Settings that belong in each repo's .phat-mode.json, not in config.json. */
const REPO_KEYS = ['repo', 'baseBranch', 'installCommand', 'checkCommand', 'labels'];
const MACHINE_KEYS = ['defaultModel', 'models', 'limits', 'watchIntervalMs', 'repos', 'allowedAuthors'];

/** Defaults, overridden by `<home>/config.json` when it exists. */
export async function loadMachineConfig(home = DEFAULT_HOME): Promise<MachineConfig> {
  const config = defaultMachineConfig(home);
  const file = join(home, 'config.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw error;
  }
  const overrides = JSON.parse(text) as Partial<Omit<MachineConfig, 'defaultModel'>> & {
    defaultModel?: Partial<ModelChoice>;
  } & Record<string, unknown>;
  const misplaced = Object.keys(overrides).filter((key) => REPO_KEYS.includes(key));
  if (misplaced.length > 0) {
    throw new Error(
      `${file}: ${misplaced.join(', ')} belong in each repo's ${REPO_SETTINGS_FILE} (run \`phat-mode init\` in the repo). List the repos to watch under "repos".`,
    );
  }
  const unknown = Object.keys(overrides).filter((key) => !MACHINE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`${file}: unknown setting(s) ${unknown.join(', ')}`);
  if (overrides.repos !== undefined && !(Array.isArray(overrides.repos) && overrides.repos.every(isRepoName))) {
    throw new Error(`${file}: "repos" must be a list of "owner/name"`);
  }
  if (overrides.allowedAuthors !== undefined && !isStringList(overrides.allowedAuthors)) {
    throw new Error(`${file}: "allowedAuthors" must be a non-empty list of GitHub user names`);
  }
  return {
    ...config,
    ...overrides,
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

export const isRepoName = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '');
const isCommand = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** A repo's .phat-mode.json, checked, so a typo fails loudly instead of being ignored. */
export function parseRepoSettings(text: string, source = REPO_SETTINGS_FILE): RepoSettings {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error(`${source} must be a JSON object`);
  const settings = json as Record<string, unknown>;
  const known = ['$schema', 'installCommand', 'checkCommand', 'baseBranch', 'allowedAuthors', 'labels'];
  const unknown = Object.keys(settings).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`${source}: unknown setting(s) ${unknown.join(', ')}`);
  if (!isCommand(settings.checkCommand)) {
    throw new Error(`${source}: "checkCommand" is required: the command that must pass before a pull request opens`);
  }
  if (!isCommand(settings.installCommand)) {
    throw new Error(`${source}: "installCommand" is required: the command that installs dependencies (or "true" for none)`);
  }
  if (settings.baseBranch !== undefined && !isCommand(settings.baseBranch)) {
    throw new Error(`${source}: "baseBranch" must be a branch name`);
  }
  if (settings.allowedAuthors !== undefined && !isStringList(settings.allowedAuthors)) {
    throw new Error(`${source}: "allowedAuthors" must be a non-empty list of GitHub user names`);
  }
  if (settings.labels !== undefined) {
    const labels = settings.labels as Record<string, unknown>;
    const bad = Object.keys(labels).filter((key) => !(key in DEFAULT_LABELS) || !isCommand(labels[key]));
    if (typeof labels !== 'object' || labels === null || bad.length > 0) {
      throw new Error(`${source}: "labels" may only rename ${Object.keys(DEFAULT_LABELS).join(', ')}`);
    }
  }
  return {
    installCommand: settings.installCommand,
    checkCommand: settings.checkCommand,
    ...(settings.baseBranch === undefined ? {} : { baseBranch: settings.baseBranch as string }),
    ...(settings.allowedAuthors === undefined ? {} : { allowedAuthors: settings.allowedAuthors }),
    ...(settings.labels === undefined ? {} : { labels: settings.labels as Partial<Labels> }),
  };
}

/**
 * The settings for one repo. Trusted authors: the repo's list, else yours, else you (the `gh` user).
 * `defaultBranch` and `viewer` come from GitHub.
 */
export function repoConfig(
  machine: MachineConfig,
  repo: string,
  settings: RepoSettings,
  github: { defaultBranch: string; viewer: string },
): Config {
  const { repos: _repos, allowedAuthors: machineAuthors, ...rest } = machine;
  return {
    ...rest,
    repo,
    baseBranch: settings.baseBranch ?? github.defaultBranch,
    allowedAuthors: settings.allowedAuthors ?? machineAuthors ?? [github.viewer],
    labels: { ...DEFAULT_LABELS, ...settings.labels },
    installCommand: settings.installCommand,
    checkCommand: settings.checkCommand,
  };
}

/** The model a role runs with: its override, field by field, over `defaultModel`. */
export function modelFor(config: Pick<Config, 'defaultModel' | 'models'>, role: Role): ModelChoice {
  return { ...config.defaultModel, ...config.models[role] };
}

export const paths = {
  state: (config: Pick<Config, 'home'>) => join(config.home, 'state.sqlite'),
  lock: (config: Pick<Config, 'home'>) => join(config.home, 'state.sqlite.lock'),
  credentials: (config: Pick<Config, 'home'>) => join(config.home, 'auth.json'),
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
