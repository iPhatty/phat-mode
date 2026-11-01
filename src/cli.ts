#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import { setToolLogger } from './agents.ts';
import {
  type Config,
  DEFAULT_LABELS,
  isRepoName,
  loadMachineConfig,
  type MachineConfig,
  modelFor,
  parseRepoSettings,
  paths,
  REPO_SETTINGS_FILE,
  ROLES,
} from './config.ts';
import { FileCredentialStore, importPiCredential } from './credentials.ts';
import { run, runShell } from './exec.ts';
import { GhGitHub, requiredLabels } from './github.ts';
import { createCopilotModels, openPhatMode, RunsDoc } from './harness.ts';
import { detectCommands, installProjectSkills, readiness, settingsFile } from './init.ts';
import { LockedError } from './lock.ts';
import { consoleLogger, consoleLoggerFor } from './log.ts';
import type { PipelineResult, Services } from './pipeline.ts';
import { currentRepo, loadRepoConfig, NotSetUpError, parseIssueRef, watchScope } from './repos.ts';
import { MATTPOCOCK_SKILLS } from './skills.ts';
import { describeStep, nextStep } from './watch.ts';
import { runOrWait, SETTLE_MS, waitToMerge } from './yolo.ts';
import { CommandChecks, GitWorkspaces, tail } from './workspace.ts';

const context = BACKGROUND_CONTEXT;
/** Recorded in the lock file, so a second process can say what is running. */
const lock = { command: `phat-mode ${process.argv.slice(2).join(' ')}`.trim() };
const PROVIDER = 'github-copilot';

const USAGE = `phat-mode: turn GitHub issues into pull requests

Usage:
  phat-mode init                Set up the repo in this folder: .phat-mode.json, labels, and what it is missing
  phat-mode login [--from-pi]   Sign in to GitHub Copilot (or copy the pi coding agent's login)
  phat-mode doctor [repo]       Check that everything phat-mode needs is set up
  phat-mode run <issue>         Work on a ready-for-agent issue until a PR is open (resumes if interrupted)
                                --yolo: then merge it once it is clean and every check passed
  phat-mode resume              Continue every run that was interrupted
  phat-mode watch [repo...]     Keep going: work on the next ready issue each time you merge a PR (Ctrl-C to stop).
                                In a set-up repo, asks whether to watch it alone or all your repos.
                                --yolo: merge phat-mode's PRs itself once they are clean and every check passed
  phat-mode status              List runs and where they are
  phat-mode abort <issue>       Stop the run for an issue

<issue> is 12 (in the repo of this folder), owner/name#12, or the issue's URL. [repo] is owner/name.
init options: --check "<command>"  --install "<command>"  --yes (accept what it detects)  --no-check (do not run it)
              --no-skills (do not copy mattpocock/skills' triage, to-tickets, to-spec and tdd, and the skills they use, into the repo)

Settings: each repo's .phat-mode.json (from \`phat-mode init\`), and yours in ~/.phat-mode/config.json (see README).`;

/** Each repo's settings, read from GitHub once per process. */
function repoConfigs(machine: MachineConfig) {
  const loaded = new Map<string, Promise<Config>>();
  return (repo: string) => {
    let config = loaded.get(repo);
    if (config === undefined) {
      config = loadRepoConfig(machine, repo);
      loaded.set(repo, config);
      config.catch(() => loaded.delete(repo));
    }
    return config;
  };
}

function servicesFor(config: Config): Services {
  return {
    config,
    logger: consoleLoggerFor(config.repo),
    github: new GhGitHub(config.repo),
    workspaces: new GitWorkspaces({
      remoteUrl: `https://github.com/${config.repo}.git`,
      baseBranch: config.baseBranch,
      cloneDir: paths.repoClone(config),
      workspaceDir: (issue) => paths.workspace(config, issue),
      baseWorkspaceDir: paths.baseWorkspace(config),
      installCommand: config.installCommand,
      installTimeoutMs: config.limits.installTimeoutMs,
    }),
    checks: new CommandChecks(config.checkCommand, config.limits.checkTimeoutMs),
  };
}

async function open(machine: MachineConfig, configFor: (repo: string) => Promise<Config>) {
  setToolLogger(consoleLogger);
  const phat = await openPhatMode(
    { home: machine.home, servicesFor: async (repo) => servicesFor(await configFor(repo)) },
    context,
    { lock, onReport: (error) => consoleLogger.error(`Report: ${error instanceof Error ? error.message : String(error)}`) },
  );
  // Ctrl-C stops cleanly. Everything is saved; `phat-mode run` or `resume` continues where it stopped.
  let closing = false;
  process.once('SIGINT', () => {
    if (closing) return;
    closing = true;
    consoleLogger.info('Stopping… progress is saved. Run the same command again to continue.');
    void phat.close(context).finally(() => process.exit(130));
  });
  return phat;
}

function describe(result: PipelineResult): string {
  switch (result.status) {
    case 'pr_opened':
      return `✅ Pull request opened: ${result.url}`;
    case 'needs_info':
      return '❓ The spec has gaps. phat-mode posted triage notes and moved the issue to needs-info.';
    case 'needs_human':
      return '🧑 phat-mode decided a human should do this and moved the issue to ready-for-human.';
    case 'ignored':
      return `⏭️  Ignored: ${result.reason}`;
  }
}

async function waitAndReport(phat: Awaited<ReturnType<typeof open>>, taskId: TaskId<PipelineResult>): Promise<number> {
  const { outcome } = (await phat.harness.waitForTask(taskId, context)).state;
  if (outcome.status === 'completed') {
    console.log(`\n${describe(outcome.result)}`);
    return 0;
  }
  if (outcome.status === 'failed') {
    console.log(`\n✖ Failed: ${outcome.error.message.split('\n')[0]}`);
    return 1;
  }
  console.log(`\n✖ ${outcome.status}`);
  return 1;
}

/** Runs that have not finished (interrupted, or still going), by `owner/name#issue`. */
async function liveRuns(phat: Awaited<ReturnType<typeof open>>) {
  const runs = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs ?? {};
  const live: { key: string; taskId: TaskId<PipelineResult> }[] = [];
  for (const [key, list] of Object.entries(runs)) {
    const taskId = list.at(-1)!.taskId as unknown as TaskId<PipelineResult>;
    const record = await phat.harness.getTask(taskId, context);
    if (record !== undefined && record.state.status !== 'terminal') live.push({ key, taskId });
  }
  return live;
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

/**
 * Work through the ready issues of `repos`, one run at a time, until Ctrl-C: finish any run that is going, then start
 * the first ready issue, in the order the repos are listed. Within a repo, nothing new starts while a phat-mode pull
 * request is open; other repos carry on. See src/watch.ts.
 */
const YOLO_WARNING =
  '⚠ --yolo: phat-mode merges its own pull requests (squash) when it found them clean, every check passed and the ' +
  `commit is ${SETTLE_MS / 60_000} minutes old. It never bypasses branch protection.`;

async function watch(machine: MachineConfig, repos: string[], yolo: boolean): Promise<number> {
  const configFor = repoConfigs(machine);
  const phat = await open(machine, configFor);
  phat.harness.resume();
  const minutes = Math.round(machine.watchIntervalMs / 60_000) || 1;
  consoleLogger.info(`Watching ${repos.join(', ')}: one issue at a time, looking every ${minutes} min. Ctrl-C to stop.`);
  if (yolo) consoleLogger.info(YOLO_WARNING);
  // What was last said about each repo: say it once, not on every look.
  const last = new Map<string, string>();
  const say = (repo: string, text: string, log = consoleLogger.info) => {
    if (last.get(repo) !== text) log(repos.length > 1 ? `${repo}: ${text}` : text);
    last.set(repo, text);
  };
  for (;;) {
    let ran = false;
    for (const { key, taskId } of await liveRuns(phat)) {
      consoleLogger.info(`Resuming ${key}`);
      await waitAndReport(phat, taskId);
      ran = true;
    }
    for (const repo of repos) {
      if (ran) break;
      try {
        const config = await configFor(repo);
        const step = await nextStep(new GhGitHub(repo), config, consoleLoggerFor(repo), { yolo });
        say(repo, describeStep(step));
        if (step.kind === 'start') {
          const { taskId } = await phat.start({ repo, issue: step.issue }, context);
          await waitAndReport(phat, taskId);
          ran = true;
        }
      } catch (error) {
        // Offline, asleep, GitHub is down, or the repo is not set up: try again on the next look.
        say(repo, error instanceof NotSetUpError ? error.message : `Could not check GitHub: ${firstLine(error)}`, consoleLogger.error);
      }
    }
    if (ran) {
      last.clear();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, machine.watchIntervalMs));
  }
}

/** `run --yolo`, once the pull request is open: wait until it merges (0) or only you can move it on (1). */
async function yoloWait(github: GhGitHub, issue: number, intervalMs: number): Promise<number> {
  const minutes = Math.round(intervalMs / 60_000) || 1;
  consoleLogger.step(issue, `Waiting to merge, looking every ${minutes} min. Ctrl-C to stop; \`phat-mode run --yolo ${issue}\` waits again.`);
  const outcome = await waitToMerge(github, issue, {
    intervalMs,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    say: (reason) => consoleLogger.step(issue, `Not merged yet: ${reason}`),
  });
  if (outcome.merged) {
    console.log(`\n✓ Merged ${outcome.url}`);
    return 0;
  }
  console.log(`\n✖ Not merging${outcome.url ? ` ${outcome.url}` : ''}: ${outcome.reason}. It is yours to look at.`);
  return 1;
}

async function login(machine: MachineConfig, fromPi: boolean): Promise<number> {
  const store = new FileCredentialStore(paths.credentials(machine));
  if (fromPi) {
    if (!(await importPiCredential(store, PROVIDER))) {
      console.error('The pi coding agent has no GitHub Copilot login. Run `phat-mode login` instead.');
      return 1;
    }
    console.log(`Copied the GitHub Copilot login from pi into ${paths.credentials(machine)}.`);
    return 0;
  }
  const models = createCopilotModels(store);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await models.login(PROVIDER, 'oauth', {
      prompt: async (prompt) => rl.question(`${prompt.message} `),
      notify: (event) => {
        if (event.type === 'device_code') console.log(`Open ${event.verificationUri} and enter the code ${event.userCode}`);
        else if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
        else console.log(event.message);
      },
    });
  } finally {
    rl.close();
  }
  console.log(`Signed in. Saved to ${paths.credentials(machine)}.`);
  return 0;
}

async function doctor(machine: MachineConfig, repos: string[]): Promise<number> {
  let ok = true;
  const check = async (name: string, test: () => Promise<string>) => {
    try {
      console.log(`✓ ${name}: ${await test()}`);
      return true;
    } catch (error) {
      ok = false;
      console.log(`✖ ${name}: ${firstLine(error)}`);
      return false;
    }
  };
  await check('node', async () => process.version);
  await check('git', async () => (await run('git', ['--version'])).stdout.trim());
  await check('git identity (for commits)', async () => {
    const name = (await run('git', ['config', 'user.name'], { allowFailure: true })).stdout.trim();
    const email = (await run('git', ['config', 'user.email'], { allowFailure: true })).stdout.trim();
    if (name === '' || email === '') throw new Error('set git config --global user.name and user.email');
    return `${name} <${email}>`;
  });
  const signedInToGh = await check('gh login', async () => {
    const result = await run('gh', ['auth', 'status'], { allowFailure: true });
    if (result.code !== 0) throw new Error('not signed in; run `gh auth login`');
    return (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
  });
  const models = createCopilotModels(new FileCredentialStore(paths.credentials(machine)));
  const signedIn = await check('Copilot login', async () => {
    const auth = await models.getAuth(PROVIDER);
    if (auth === undefined) throw new Error('not signed in; run `phat-mode login` or `phat-mode login --from-pi`');
    return `via ${auth.source}`;
  });
  if (signedIn) {
    for (const role of ROLES) {
      const choice = modelFor(machine, role);
      await check(`model for ${role}`, async () => {
        const available = await models.getAvailable();
        if (!available.some((model) => model.provider === choice.provider && model.id === choice.modelId)) {
          throw new Error(`${choice.provider}/${choice.modelId} is not available on this account`);
        }
        return `${choice.provider}/${choice.modelId} (thinking: ${choice.thinkingLevel})`;
      });
    }
  }
  if (!signedInToGh) return 1;
  if (repos.length === 0) console.log('– repos: none named, none in config.json "repos", and this folder is not a GitHub clone');
  for (const repo of repos) {
    let config: Config | undefined;
    const loaded = await check(`${repo}: ${REPO_SETTINGS_FILE}`, async () => {
      config = await loadRepoConfig(machine, repo);
      return `check \`${config.checkCommand}\`, install \`${config.installCommand}\`, PRs into ${config.baseBranch}, trusting ${config.allowedAuthors.join(', ')}`;
    });
    if (!loaded) continue;
    await check(`${repo}: access`, async () => {
      const view = JSON.parse((await run('gh', ['repo', 'view', repo, '--json', 'viewerPermission'])).stdout);
      if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(view.viewerPermission)) throw new Error('no write access');
      return view.viewerPermission;
    });
    const { labels } = config!;
    await check(`${repo}: labels`, async () => {
      const missing = await new GhGitHub(repo).missingLabels(requiredLabels(labels));
      if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}; run \`phat-mode init\` in the repo`);
      return `all there (agent mode: \`${labels.agentMode}\`)`;
    });
  }
  return ok ? 0 : 1;
}

type InitOptions = { yes: boolean; runCheck: boolean; skills: boolean; check?: string; install?: string };

function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = { yes: false, runCheck: true, skills: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-check') options.runCheck = false;
    else if (arg === '--no-skills') options.skills = false;
    else if ((arg === '--check' || arg === '--install') && args[i + 1] !== undefined) options[arg === '--check' ? 'check' : 'install'] = args[++i]!;
    else throw new Error(`Unknown option for init: ${arg}`);
  }
  return options;
}

/** Set up the repo in this folder. Writes .phat-mode.json (never overwrites it), creates the labels, says what is missing. */
async function init(machine: MachineConfig, args: string[]): Promise<number> {
  const options = parseInitOptions(args);
  const top = await run('git', ['rev-parse', '--show-toplevel'], { allowFailure: true });
  const repo = top.code === 0 ? await currentRepo(top.stdout.trim()) : undefined;
  if (repo === undefined) {
    console.error('✖ Run `phat-mode init` inside a clone of a GitHub repo.');
    return 2;
  }
  const root = top.stdout.trim();
  const file = join(root, REPO_SETTINGS_FILE);
  console.log(`Setting up ${repo} (${root})\n`);

  const existing = await readFile(file, 'utf8').catch(() => undefined);
  let settings;
  if (existing !== undefined) {
    settings = parseRepoSettings(existing, file);
    console.log(`✓ ${REPO_SETTINGS_FILE} is already here; keeping it.`);
  } else {
    const detected = await detectCommands(root);
    console.log(`Looked at: ${detected.notes.join('; ')}`);
    const interactive = !options.yes && process.stdin.isTTY;
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const ask = async (label: string, flag: string, given: string | undefined, suggestion: string | undefined) => {
      if (given !== undefined) return given;
      if (rl === undefined) {
        if (suggestion === undefined) throw new Error(`No ${label.toLowerCase()} found. Pass ${flag} "<command>".`);
        return suggestion;
      }
      for (;;) {
        const answer = (await rl.question(`${label}${suggestion ? ` [${suggestion}]` : ''}: `)).trim();
        if (answer !== '' || suggestion !== undefined) return answer || suggestion!;
      }
    };
    try {
      console.log('The check command must pass before phat-mode opens a pull request: make it run every check you rely on (lint, types, tests).');
      settings = {
        installCommand: await ask('Install command', '--install', options.install, detected.installCommand),
        checkCommand: await ask('Check command', '--check', options.check, detected.checkCommand),
      };
    } finally {
      rl?.close();
    }
  }

  let checkOk = true;
  if (options.runCheck) {
    console.log(`\nRunning \`${settings.checkCommand}\` here, to see that it passes on what you have checked out…`);
    const result = await runShell(settings.checkCommand, { cwd: root, allowFailure: true, timeoutMs: machine.limits.checkTimeoutMs });
    checkOk = result.code === 0;
    if (checkOk) console.log('✓ The check command passes.');
    else {
      console.log(`✖ The check command fails (exit ${result.code}). Every run would fail its checks until it passes on the base branch.`);
      console.log(tail(`${result.stdout}\n${result.stderr}`.trim(), 1500));
    }
  }
  if (existing === undefined) {
    await writeFile(file, settingsFile(settings));
    console.log(`✓ Wrote ${REPO_SETTINGS_FILE}`);
  }

  const created = await new GhGitHub(repo).ensureLabels(requiredLabels({ ...DEFAULT_LABELS, ...settings.labels }));
  console.log(`✓ Labels: ${created.length > 0 ? `created ${created.join(', ')}` : 'all there'}`);

  // The skills that make issues ready-for-agent, for the people who prepare them.
  let skillsAdded = false;
  if (options.skills) {
    const skills = await installProjectSkills(root);
    skillsAdded = skills.installed.length > 0;
    if (skillsAdded) console.log(`✓ Added mattpocock/skills (${MATTPOCOCK_SKILLS.label}): ${[...skills.installed, ...skills.linked].join(', ')}`);
    if (skills.kept.length > 0) console.log(`✓ Kept the repo's own skills: ${skills.kept.join(', ')}`);
  }

  const ready = await readiness(root);
  console.log(
    ready.standards.length > 0
      ? `✓ Standards for agents and the code review: ${ready.standards.join(', ')}`
      : '– No AGENTS.md (or CLAUDE.md, CONTRIBUTING.md): agents and the Standards reviewer have no repo rules to follow. Write one.',
  );
  console.log(
    ready.verifySkills.length > 0
      ? `✓ Verification skill: ${ready.verifySkills.join(', ')}`
      : '– No verification skill: changes are not tried in the real app. Create one with /create-verification-skill (pstack).',
  );
  console.log(
    ready.triageLabels
      ? `✓ Triage label mapping: ${ready.triageLabels}. If it renames labels, copy them into "labels" in ${REPO_SETTINGS_FILE}.`
      : options.skills
        ? '– No triage setup yet: run /setup-matt-pocock-skills once in your agent, then /triage, /to-tickets or /to-spec make issues ready-for-agent.'
        : '– No triage setup from mattpocock/skills: label issues ready-for-agent yourself (or install the skills and use /triage, /to-tickets).',
  );

  // Add the repo to the ones `phat-mode watch` works on.
  const configFile = join(machine.home, 'config.json');
  if (!machine.repos.includes(repo)) {
    const current = JSON.parse((await readFile(configFile, 'utf8').catch(() => undefined)) ?? '{}') as Record<string, unknown>;
    await writeFile(configFile, `${JSON.stringify({ ...current, repos: [...machine.repos, repo] }, null, 2)}\n`);
    console.log(`✓ Added ${repo} to "repos" in ${configFile}, for \`phat-mode watch\``);
  }

  // phat-mode reads the settings from GitHub, so they only count once they are on the base branch.
  const published = await loadRepoConfig(machine, repo).then(
    () => true,
    (error) => (error instanceof NotSetUpError ? false : Promise.reject(error)),
  );
  console.log('\nNext:');
  if (!published) console.log(`  - Commit ${REPO_SETTINGS_FILE} and push it to the default branch: phat-mode reads it from GitHub, not from this folder.`);
  if (skillsAdded) console.log('  - Commit the added skills, so everyone preparing issues for phat-mode has them.');
  console.log('  - Label an issue ready-for-agent, then `phat-mode run <issue>` (or `phat-mode watch`).');
  return checkOk ? 0 : 1;
}

async function status(machine: MachineConfig): Promise<number> {
  const phat = await openPhatMode({ home: machine.home, servicesFor: repoServices(machine) }, context, { lock });
  try {
    const runs = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs ?? {};
    const keys = Object.keys(runs);
    if (keys.length === 0) console.log('No runs yet.');
    for (const key of keys) {
      const latest = runs[key]!.at(-1)!;
      const record = await phat.harness.getTask(latest.taskId as unknown as TaskId<PipelineResult>, context);
      const state = record?.state;
      let text = 'unknown';
      if (state?.status === 'terminal') {
        const outcome = state.outcome;
        text = outcome.status === 'completed' ? describe(outcome.result) : `${outcome.status}${outcome.status === 'failed' ? `: ${outcome.error.message.split('\n')[0]}` : ''}`;
      } else if (state !== undefined) {
        const phase = 'checkpoint' in state ? (state.checkpoint as { phase?: string }).phase : undefined;
        text = `${state.status}${phase ? ` (${phase})` : ''}, run \`phat-mode resume\` to continue`;
      }
      console.log(`${key}  ${text}`);
    }
  } finally {
    await phat.close(context);
  }
  return 0;
}

const repoServices = (machine: MachineConfig) => {
  const configFor = repoConfigs(machine);
  return async (repo: string) => servicesFor(await configFor(repo));
};

/** The repo of this folder, and whether it is set up: has a .phat-mode.json, from `phat-mode init`. */
async function repoHere(): Promise<{ repo: string; setUp: boolean } | undefined> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.code !== 0) return undefined;
  const root = top.stdout.trim();
  const repo = await currentRepo(root);
  if (repo === undefined) return undefined;
  const setUp = await access(join(root, REPO_SETTINGS_FILE)).then(
    () => true,
    () => false,
  );
  return { repo, setUp };
}

/** Ask whether to watch only `here` or `all` repos. Not at a terminal, nobody can answer: all, as before. */
async function chooseWatchRepos(here: string, all: string[]): Promise<string[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`${here} is set up for phat-mode; watching all ${all.length} repos. Run \`phat-mode watch ${here}\` to watch it alone.`);
    return all;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C at the question stops, as it does everywhere else.
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  try {
    console.log(`This folder is ${here}, set up for phat-mode. Watch:\n  1) ${here} only\n  2) all ${all.length} repos: ${all.join(', ')}`);
    for (;;) {
      const answer = (await rl.question('Choice [1]: ')).trim();
      if (answer === '' || answer === '1') return [here];
      if (answer === '2') return all;
    }
  } finally {
    rl.close();
  }
}

/** Repos named on the command line, else the ones in config.json, else this folder's. */
async function reposFrom(args: string[], machine: MachineConfig): Promise<string[]> {
  const bad = args.filter((arg) => !isRepoName(arg));
  if (bad.length > 0) throw new Error(`Not a repo (owner/name): ${bad.join(', ')}`);
  if (args.length > 0) return args;
  if (machine.repos.length > 0) return machine.repos;
  const here = await currentRepo();
  return here === undefined ? [] : [here];
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const machine = await loadMachineConfig();

  switch (command) {
    case 'init':
      return init(machine, args);
    case 'login':
      return login(machine, args[0] === '--from-pi');
    case 'doctor': {
      const here = args.length === 0 ? await currentRepo() : undefined;
      const repos = await reposFrom(args, machine);
      return doctor(machine, here === undefined || repos.includes(here) ? repos : [here, ...repos]);
    }
    case 'status':
      return status(machine);
    case 'run': {
      const yolo = args.includes('--yolo');
      const ref = args.find((arg) => arg !== '--yolo');
      if (ref === undefined) {
        console.error('Usage: phat-mode run [--yolo] <issue>   (12, owner/name#12 or the issue URL)');
        return 2;
      }
      const { repo, issue } = parseIssueRef(ref, await currentRepo());
      const configFor = repoConfigs(machine);
      // Fail before starting if the repo is not set up, rather than inside the run.
      await configFor(repo);
      const phat = await open(machine, configFor);
      const github = new GhGitHub(repo);
      if (yolo) consoleLogger.info(YOLO_WARNING);
      const runGoing = (await liveRuns(phat)).some((run) => run.key === `${repo}#${issue}`);
      if (!yolo || (await runOrWait(github, issue, { runGoing })) === 'run') {
        const { taskId, resumed } = await phat.start({ repo, issue }, context);
        consoleLogger.info(`${resumed ? 'Resuming' : 'Starting'} ${repo}#${issue}`);
        phat.harness.resume();
        const code = await waitAndReport(phat, taskId);
        const { outcome } = (await phat.harness.waitForTask(taskId, context)).state;
        if (!yolo || code !== 0 || outcome.status !== 'completed' || outcome.result.status !== 'pr_opened') {
          await phat.close(context);
          return code;
        }
      }
      const code = await yoloWait(github, issue, machine.watchIntervalMs);
      await phat.close(context);
      return code;
    }
    case 'resume': {
      const phat = await open(machine, repoConfigs(machine));
      phat.harness.resume();
      const live = await liveRuns(phat);
      let code = 0;
      for (const { key, taskId } of live) {
        consoleLogger.info(`Resuming ${key}`);
        code = Math.max(code, await waitAndReport(phat, taskId));
      }
      if (live.length === 0) console.log('Nothing to resume.');
      await phat.close(context);
      return code;
    }
    case 'watch': {
      const yolo = args.includes('--yolo');
      const named = args.filter((arg) => arg !== '--yolo');
      let repos: string[];
      if (named.length > 0) repos = await reposFrom(named, machine);
      else {
        const scope = watchScope(machine.repos, await repoHere());
        repos = 'repos' in scope ? scope.repos : await chooseWatchRepos(scope.choose.here, scope.choose.all);
      }
      if (repos.length === 0) {
        console.error('✖ Which repos? Run it in a clone, name them (phat-mode watch owner/name), or list them under "repos" in ~/.phat-mode/config.json.');
        return 2;
      }
      return watch(machine, repos, yolo);
    }
    case 'abort': {
      if (args[0] === undefined) {
        console.error('Usage: phat-mode abort <issue>');
        return 2;
      }
      const { repo, issue } = parseIssueRef(args[0], await currentRepo());
      const phat = await openPhatMode({ home: machine.home, servicesFor: repoServices(machine) }, context, { lock });
      const list = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs[`${repo}#${issue}`];
      if (list === undefined) {
        console.log(`No run for ${repo}#${issue}.`);
      } else {
        phat.harness.resume();
        const taskId = list.at(-1)!.taskId as unknown as TaskId<PipelineResult>;
        console.log(`Abort ${repo}#${issue}: ${await phat.harness.abortTask(taskId, context)}`);
        await phat.harness.waitForTask(taskId, context);
      }
      await phat.close(context);
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof LockedError || error instanceof NotSetUpError) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 3;
  } else if (error instanceof Error && !(error instanceof TypeError) && !(error instanceof ReferenceError)) {
    // Expected problems (a bad issue reference, a bad settings file, GitHub unreachable): one line, no stack.
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
