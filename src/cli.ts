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
  projectsWithState,
  REPO_SETTINGS_FILE,
  ROLES,
} from './config.ts';
import { FileCredentialStore, importPiCredential } from './credentials.ts';
import { run, runShell } from './exec.ts';
import { GhGitHub, requiredLabels } from './github.ts';
import { createCopilotModels, openPhatMode, type PhatMode, type RunKind, type RunResult, RunsDoc } from './harness.ts';
import { detectCommands, installProjectSkills, readiness, settingsFile } from './init.ts';
import { describeHolder, LockedError, type LockInfo } from './lock.ts';
import {
  describeUnfinished,
  finishInterrupted,
  liveRuns,
  projectStatus,
  resumeInterrupted,
  resumeOnce,
  retireLegacyState,
  takenOver,
  takeProjects,
  watchedBy,
} from './projects.ts';
import { consoleLogger, consoleLoggerFor } from './log.ts';
import type { Services } from './pipeline.ts';
import { currentRepo, loadRepoConfig, NotSetUpError, parseIssueRef, watchScope } from './repos.ts';
import { describeResult } from './runs.ts';
import { MATTPOCOCK_SKILLS, PSTACK_SKILLS, VERIFICATION_SKILLS } from './skills.ts';
import { type ProjectQueue, watchProjects } from './scheduler.ts';
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
  phat-mode run <issue>         Work on a ready-for-agent issue until a PR is open, or shape an agent-mode
                                issue (resumes if interrupted)
                                --yolo: then merge the PR once it is clean and every check passed
  phat-mode resume              Continue every run that was interrupted, in every project no other process holds
  phat-mode watch [repo...]     Keep going: work on the next ready issue each time you merge a PR (Ctrl-C to stop).
                                In a set-up repo, asks whether to watch it alone or all your repos.
                                --yolo: merge phat-mode's PRs itself once they are clean and every check passed
  phat-mode status              List every project's runs and where they are; for a project another phat-mode process
                                holds, what that process is doing
  phat-mode abort <issue>       Stop the run for an issue

<issue> is 12 (in the repo of this folder), owner/name#12, or the issue's URL. [repo] is owner/name.
init options: --check "<command>"  --install "<command>"  --yes (accept what it detects)  --no-check (do not run it)
              --no-skills (do not copy mattpocock/skills' triage, to-tickets, to-spec and tdd, and the skills they use, or pstack's
                verification skills, into the repo)

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
      shapeWorkspaceDir: (issue) => paths.shapeWorkspace(config, issue),
      installCommand: config.installCommand,
      installTimeoutMs: config.limits.installTimeoutMs,
    }),
    checks: new CommandChecks(config.checkCommand, config.limits.checkTimeoutMs),
  };
}

/** Open one project: take its lock (LockedError when another process holds it) and its database. */
async function open(machine: MachineConfig, repo: string, configFor: (repo: string) => Promise<Config>) {
  setToolLogger(consoleLogger);
  return openPhatMode(
    { home: machine.home, repo, servicesFor: async (repo) => servicesFor(await configFor(repo)) },
    context,
    { lock, onReport: (error) => consoleLogger.error(`Report: ${error instanceof Error ? error.message : String(error)}`) },
  );
}

/** Ctrl-C stops cleanly, closing every open project. Everything is saved; `phat-mode run` or `resume` continues. */
function closeOnCtrlC(phats: () => Iterable<PhatMode>) {
  let closing = false;
  process.once('SIGINT', () => {
    if (closing) return;
    closing = true;
    consoleLogger.info('Stopping… progress is saved. Run the same command again to continue.');
    void Promise.allSettled([...phats()].map((phat) => phat.close(context))).finally(() => process.exit(130));
  });
}

/** Wait for a run to settle and say how it ended, naming the run (`owner/name#12`): parallel runs share the log. */
async function waitAndReport(phat: PhatMode, taskId: TaskId<RunResult>, key: string): Promise<number> {
  const settled = await phat.harness.waitForTask(taskId, context);
  const { outcome } = settled.state;
  if (outcome.status === 'completed') {
    console.log(`\n${key}: ${describeResult(outcome.result, settled.kind)}`);
    return 0;
  }
  if (outcome.status === 'failed') {
    console.log(`\n✖ ${key} failed: ${outcome.error.message.split('\n')[0]}`);
    return 1;
  }
  console.log(`\n✖ ${key}: ${outcome.status}`);
  return 1;
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

const YOLO_WARNING =
  '⚠ --yolo: phat-mode merges its own pull requests (squash) when it found them clean, every check passed and the ' +
  `commit is ${SETTLE_MS / 1_000} seconds old. It never bypasses branch protection.`;

/**
 * Work through the ready and `agent-mode` issues of `repos` until Ctrl-C: up to `maxParallelRuns` runs at once, at most
 * one per project (src/scheduler.ts). Each project keeps its own queue: finish a run left interrupted, then shape or
 * start its next issue (src/watch.ts). Within a repo, shaping goes ahead while a phat-mode pull request is open, but no
 * new build starts; waiting for that pull request takes no slot.
 */
async function watch(machine: MachineConfig, repos: string[], yolo: boolean): Promise<number> {
  const configFor = repoConfigs(machine);
  // The lock of every free project in the list; those another process holds are skipped, and tried again on every look.
  // `repos` is read once, at start: a project added to config.json later is watched after a restart.
  const projects = await takeProjects(repos, (repo) => open(machine, repo, configFor));
  closeOnCtrlC(() => projects.held());
  for (const [repo, holder] of projects.skipped) consoleLogger.info(watchedBy(repo, holder));
  if (projects.held().length === 0) {
    await projects.close(context);
    console.error('✖ Nothing to watch: other processes hold every project in the list.');
    return 1;
  }
  const { maxParallelRuns } = machine;
  const minutes = Math.round(machine.watchIntervalMs / 60_000) || 1;
  const watching = projects.held().map((phat) => phat.repo);
  const waiting = [...projects.skipped.keys()];
  const runs = maxParallelRuns === 1 ? 'one run at a time' : `up to ${maxParallelRuns} runs at once (one per project)`;
  consoleLogger.info(
    `Watching ${watching.join(', ')}${waiting.length > 0 ? `; waiting for ${waiting.join(', ')}` : ''}: ${runs}, ` +
      `looking every ${minutes} min. Ctrl-C to stop.`,
  );
  if (yolo) consoleLogger.info(YOLO_WARNING);
  // What was last said about each repo: say it once, not on every look. Every line names its repo.
  const last = new Map<string, string>();
  const say = (repo: string, text: string, log = consoleLogger.info) => {
    if (last.get(repo) !== text) log(`${repo}: ${text}`);
    last.set(repo, text);
  };
  /** Wait for a run, then say again what the project is doing, at its next look. */
  const waitFor = (phat: PhatMode, key: string, taskId: TaskId<RunResult>) => async () => {
    try {
      await waitAndReport(phat, taskId, key);
    } catch (error) {
      // Its slot is freed all the same; the other projects' runs carry on.
      consoleLogger.error(`${key}: ${firstLine(error)}`);
    } finally {
      last.delete(phat.repo);
    }
  };
  // One project's queue. Its runs go ahead (resumeOnce) only when it gets a slot: resuming runs everything it has pending.
  const queueOf = (phat: PhatMode): ProjectQueue => ({
    repo: phat.repo,
    async next() {
      const repo = phat.repo;
      // Runs left interrupted: all of them go ahead, one at a time, in this project's one slot.
      const interrupted = await resumeInterrupted(phat, context, async (key, taskId) => {
        consoleLogger.info(`Resuming ${key}`);
        await waitFor(phat, key, taskId)();
      });
      if (interrupted !== undefined) return interrupted;
      const config = await configFor(repo);
      const step = await nextStep(new GhGitHub(repo), config, consoleLoggerFor(repo), { yolo });
      say(repo, describeStep(step));
      if (step.kind !== 'start' && step.kind !== 'shape') return undefined;
      resumeOnce(phat);
      const { taskId } = await phat.start({ repo, issue: step.issue }, context, step.kind === 'shape' ? 'shape' : 'build');
      return waitFor(phat, `${repo}#${step.issue}`, taskId);
    },
  });
  await watchProjects({
    async projects() {
      // Projects whose holder has exited since: taken over, within one look.
      for (const { repo, previous } of await projects.retake()) consoleLogger.info(takenOver(repo, previous));
      return projects.held().map(queueOf);
    },
    maxParallelRuns,
    sleep: (wake) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, machine.watchIntervalMs);
        wake.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    onError: (repo, error) =>
      // Offline, asleep, GitHub is down, or the repo is not set up: try again on the next look.
      say(repo, error instanceof NotSetUpError ? error.message : `Could not check GitHub: ${firstLine(error)}`, consoleLogger.error),
  });
  return 0;
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
      const missing = await new GhGitHub(repo).missingLabels(requiredLabels(labels).map((label) => label.name));
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

  const labels = await new GhGitHub(repo).ensureLabels(requiredLabels({ ...DEFAULT_LABELS, ...settings.labels }));
  if (labels.failed.length === 0) console.log(`✓ Labels: ${labels.created.length > 0 ? `created ${labels.created.join(', ')}` : 'all there'}`);
  else {
    if (labels.created.length > 0) console.log(`✓ Labels: created ${labels.created.join(', ')}`);
    console.log(`✖ Could not create ${labels.failed.length === 1 ? 'a label' : 'labels'} phat-mode needs:`);
    for (const { name, reason } of labels.failed) console.log(`  - ${name}: ${tail(reason, 300)}`);
    console.log('  Creating labels needs write access to the repo. Create them on GitHub, or run `phat-mode init` again with access.');
  }

  // The skills that make issues ready-for-agent, for the people who prepare them, and the ones that make a verify skill.
  let skillsAdded = false;
  if (options.skills) {
    const skills = await installProjectSkills(root);
    skillsAdded = skills.installed.length > 0;
    const fromPstack = (path: string) => VERIFICATION_SKILLS.some((skill) => path.endsWith(`/${skill}`));
    const added = [...skills.installed, ...skills.linked];
    const matt = added.filter((path) => !fromPstack(path));
    const pstack = added.filter(fromPstack);
    if (matt.length > 0) console.log(`✓ Added mattpocock/skills (${MATTPOCOCK_SKILLS.label}): ${matt.join(', ')}`);
    if (pstack.length > 0) console.log(`✓ Added pstack's verification skills (${PSTACK_SKILLS.label}): ${pstack.join(', ')}`);
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
      : options.skills
        ? '– No verification skill: changes are not tried in the real app. Run /create-verification-skill once in your agent, and commit the verify-<app> skill it writes.'
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
  if (skillsAdded) console.log('  - Commit the added skills, so everyone preparing issues and verification skills for phat-mode has them.');
  console.log('  - Label an issue ready-for-agent, then `phat-mode run <issue>` (or `phat-mode watch`).');
  return checkOk && labels.failed.length === 0 ? 0 : 1;
}

/** Every project to look at: the ones in config.json, then any other with a database (`run` works on any repo). */
async function knownProjects(machine: MachineConfig): Promise<string[]> {
  return [...new Set([...machine.repos, ...(await projectsWithState(machine.home))])];
}

/** "doing #12 build (plan)", or "idle". */
const describeDoing = (holder: LockInfo) =>
  holder.doing === undefined ? 'idle' : `doing #${holder.doing.issue} ${holder.doing.kind} (${holder.doing.phase})`;

async function status(machine: MachineConfig): Promise<number> {
  const projects = await knownProjects(machine);
  if (projects.length === 0) console.log('No projects yet: none in config.json "repos", and no runs.');
  for (const repo of projects) {
    console.log(repo);
    const project = await projectStatus(machine.home, repo, context, { lock });
    if ('held' in project) {
      console.log(`  held by ${describeHolder(project.held)}: ${describeDoing(project.held)}`);
      continue;
    }
    if (project.runs.length === 0) console.log('  No runs yet.');
    for (const run of project.runs) console.log(`  ${run.key}  ${run.status}`);
  }
  return 0;
}

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

const COMMANDS = ['init', 'login', 'doctor', 'status', 'run', 'resume', 'watch', 'abort'];

/**
 * The database every project shared before (`state.sqlite`): archived once no run in it is unfinished. With unfinished
 * runs, false, after saying how to finish them; `status` (`warnOnly`) says so and carries on.
 */
async function legacyStateRetired(machine: MachineConfig, warnOnly: boolean): Promise<boolean> {
  let retired;
  try {
    retired = await retireLegacyState(machine.home, context);
  } catch (error) {
    // An earlier phat-mode still uses it: `status` says so and carries on; the rest stop, naming it (exit 1).
    if (!(warnOnly && error instanceof LockedError)) throw error;
    console.error(`⚠ ${error.message}\n`);
    return true;
  }
  if (retired.status === 'archived') {
    consoleLogger.info(`Archived the old shared database to ${paths.legacyState(machine.home)}.legacy: each project has its own now.`);
  }
  if (retired.status !== 'unfinished') return true;
  console.error(`${warnOnly ? '⚠' : '✖'} ${describeUnfinished(retired.runs, machine.home)}\n`);
  return warnOnly;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const machine = await loadMachineConfig();
  if (COMMANDS.includes(command ?? '') && !(await legacyStateRetired(machine, command === 'status'))) return 1;

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
      // An agent-mode issue is shaped, not built. A run still going is resumed whatever its kind.
      const agentMode = (await configFor(repo)).labels.agentMode;
      const github = new GhGitHub(repo);
      const kind: RunKind = (await github.getIssue(issue)).labels.includes(agentMode) ? 'shape' : 'build';
      const phat = await open(machine, repo, configFor);
      closeOnCtrlC(() => [phat]);
      if (yolo) consoleLogger.info(YOLO_WARNING);
      const runGoing = (await liveRuns(phat, context)).some((run) => run.key === `${repo}#${issue}`);
      if (!yolo || (await runOrWait(github, issue, { runGoing })) === 'run') {
        const { taskId, resumed } = await phat.start({ repo, issue }, context, kind);
        consoleLogger.info(`${resumed ? 'Resuming' : kind === 'shape' ? 'Shaping' : 'Starting'} ${repo}#${issue}`);
        phat.harness.resume();
        const code = await waitAndReport(phat, taskId, `${repo}#${issue}`);
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
      // Projects with a database are the only ones with runs to resume. One another process holds is skipped.
      const configFor = repoConfigs(machine);
      const opened = new Set<PhatMode>();
      closeOnCtrlC(() => opened);
      let code = 0;
      let resumed = 0;
      for (const repo of await projectsWithState(machine.home)) {
        let phat: PhatMode;
        try {
          phat = await open(machine, repo, configFor);
        } catch (error) {
          if (!(error instanceof LockedError)) throw error;
          console.error(`✖ ${repo} is held by ${describeHolder(error.holder)}; not resuming it.`);
          code = 1;
          continue;
        }
        opened.add(phat);
        resumed += await finishInterrupted([phat], context, async (phat, key, taskId) => {
          consoleLogger.info(`Resuming ${key}`);
          code = Math.max(code, await waitAndReport(phat, taskId, key));
        });
        await phat.close(context);
        opened.delete(phat);
      }
      if (resumed === 0) console.log('Nothing to resume.');
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
      const phat = await open(machine, repo, repoConfigs(machine));
      const list = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs[`${repo}#${issue}`];
      if (list === undefined) {
        console.log(`No run for ${repo}#${issue}.`);
      } else {
        phat.harness.resume();
        const taskId = list.at(-1)!.taskId as unknown as TaskId<RunResult>;
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
  if (error instanceof NotSetUpError) {
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
