#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import { setToolLogger } from './agents.ts';
import { type Config, loadConfig, modelFor, paths, ROLES } from './config.ts';
import { FileCredentialStore, importPiCredential } from './credentials.ts';
import { run } from './exec.ts';
import { GhGitHub } from './github.ts';
import { createCopilotModels, openPhatMode, RunsDoc } from './harness.ts';
import { LockedError } from './lock.ts';
import { consoleLogger } from './log.ts';
import type { PipelineResult, Services } from './pipeline.ts';
import { CommandChecks, GitWorkspaces } from './workspace.ts';

const context = BACKGROUND_CONTEXT;
/** Recorded in the lock file, so a second process can say what is running. */
const lock = { command: `phat-mode ${process.argv.slice(2).join(' ')}`.trim() };
const PROVIDER = 'github-copilot';

const USAGE = `phat-mode: turn GitHub issues into draft pull requests

Usage:
  phat-mode login [--from-pi]   Sign in to GitHub Copilot (or copy the pi coding agent's login)
  phat-mode doctor              Check that everything phat-mode needs is set up
  phat-mode run <issue>         Work on a ready-for-agent issue until a draft PR is open (resumes if interrupted)
  phat-mode resume              Continue every run that was interrupted
  phat-mode status              List runs and where they are
  phat-mode abort <issue>       Stop the run for an issue

Config: ~/.phat-mode/config.json (optional; see README)`;

function services(config: Config): Services {
  return {
    config,
    logger: consoleLogger,
    github: new GhGitHub(config.repo),
    workspaces: new GitWorkspaces({
      remoteUrl: `https://github.com/${config.repo}.git`,
      baseBranch: config.baseBranch,
      cloneDir: paths.repoClone(config),
      workspaceDir: (issue) => paths.workspace(config, issue),
      installCommand: config.installCommand,
      installTimeoutMs: config.limits.installTimeoutMs,
    }),
    checks: new CommandChecks(config.checkCommand, config.limits.checkTimeoutMs),
  };
}

async function open(config: Config) {
  setToolLogger(consoleLogger);
  const phat = await openPhatMode(services(config), context, {
    lock,
    onReport: (error) => consoleLogger.error(`Report: ${error instanceof Error ? error.message : String(error)}`),
  });
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
      return `✅ Draft pull request opened: ${result.url}`;
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

async function login(config: Config, fromPi: boolean): Promise<number> {
  const store = new FileCredentialStore(paths.credentials(config));
  if (fromPi) {
    if (!(await importPiCredential(store, PROVIDER))) {
      console.error('The pi coding agent has no GitHub Copilot login. Run `phat-mode login` instead.');
      return 1;
    }
    console.log(`Copied the GitHub Copilot login from pi into ${paths.credentials(config)}.`);
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
  console.log(`Signed in. Saved to ${paths.credentials(config)}.`);
  return 0;
}

async function doctor(config: Config): Promise<number> {
  let ok = true;
  const check = async (name: string, test: () => Promise<string>) => {
    try {
      console.log(`✓ ${name}: ${await test()}`);
    } catch (error) {
      ok = false;
      console.log(`✖ ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  };
  await check('node', async () => process.version);
  await check('git', async () => (await run('git', ['--version'])).stdout.trim());
  await check('gh login', async () => {
    const result = await run('gh', ['auth', 'status'], { allowFailure: true });
    if (result.code !== 0) throw new Error('not signed in; run `gh auth login`');
    return 'signed in';
  });
  await check(`repo ${config.repo}`, async () => {
    const repo = JSON.parse((await run('gh', ['repo', 'view', config.repo, '--json', 'viewerPermission'])).stdout);
    if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission)) throw new Error('no write access');
    return `access ${repo.viewerPermission}`;
  });
  const models = createCopilotModels(new FileCredentialStore(paths.credentials(config)));
  let signedIn = false;
  await check('Copilot login', async () => {
    const auth = await models.getAuth(PROVIDER);
    if (auth === undefined) throw new Error('not signed in; run `phat-mode login` or `phat-mode login --from-pi`');
    signedIn = true;
    return `via ${auth.source}`;
  });
  if (!signedIn) return 1;
  for (const role of ROLES) {
    const choice = modelFor(config, role);
    await check(`model for ${role}`, async () => {
      const available = await models.getAvailable();
      if (!available.some((model) => model.provider === choice.provider && model.id === choice.modelId)) {
        throw new Error(`${choice.provider}/${choice.modelId} is not available on this account`);
      }
      return `${choice.provider}/${choice.modelId} (thinking: ${choice.thinkingLevel})`;
    });
  }
  return ok ? 0 : 1;
}

async function status(config: Config): Promise<number> {
  const phat = await openPhatMode(services(config), context, { lock });
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

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  const config = await loadConfig();

  switch (command) {
    case 'login':
      return login(config, arg === '--from-pi');
    case 'doctor':
      return doctor(config);
    case 'status':
      return status(config);
    case 'run': {
      const issue = Number(arg);
      if (!Number.isInteger(issue) || issue <= 0) {
        console.error('Usage: phat-mode run <issue number>');
        return 2;
      }
      const phat = await open(config);
      const { taskId, resumed } = await phat.start({ repo: config.repo, issue }, context);
      consoleLogger.info(`${resumed ? 'Resuming' : 'Starting'} ${config.repo}#${issue}`);
      phat.harness.resume();
      const code = await waitAndReport(phat, taskId);
      await phat.close(context);
      return code;
    }
    case 'resume': {
      const phat = await open(config);
      phat.harness.resume();
      const runs = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs ?? {};
      let code = 0;
      let any = false;
      for (const [key, list] of Object.entries(runs)) {
        const taskId = list.at(-1)!.taskId as unknown as TaskId<PipelineResult>;
        const record = await phat.harness.getTask(taskId, context);
        if (record === undefined || record.state.status === 'terminal') continue;
        any = true;
        consoleLogger.info(`Resuming ${key}`);
        code = Math.max(code, await waitAndReport(phat, taskId));
      }
      if (!any) console.log('Nothing to resume.');
      await phat.close(context);
      return code;
    }
    case 'abort': {
      const issue = Number(arg);
      const phat = await openPhatMode(services(config), context, { lock });
      const list = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs[`${config.repo}#${issue}`];
      if (list === undefined) {
        console.log(`No run for #${issue}.`);
      } else {
        phat.harness.resume();
        const taskId = list.at(-1)!.taskId as unknown as TaskId<PipelineResult>;
        console.log(`Abort #${issue}: ${await phat.harness.abortTask(taskId, context)}`);
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
  if (!(error instanceof LockedError)) throw error;
  console.error(`✖ ${error.message}`);
  process.exitCode = 3;
}
