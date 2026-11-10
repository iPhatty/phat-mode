import { mkdir } from 'node:fs/promises';
import type { Context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import type { CredentialStore, Models } from '@earendil-works/pi-ai';
import {
  type Conversation,
  createRegistry,
  defineDoc,
  Harness,
  type Storage,
  type TaskId,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { guardFor, Tools } from './agents.ts';
import { paths } from './config.ts';
import { FileCredentialStore } from './credentials.ts';
import { agentEnv } from './exec.ts';
import { acquireLock, type Doing } from './lock.ts';
import { createPipeline, type PipelineInput, type PipelineResult, type Services } from './pipeline.ts';
import { createRepair, type RepairResult } from './repair.ts';
import { createShaping, type ShapingResult } from './shaping.ts';
import { Skills } from './standing-skills.ts';

/**
 * What a run is: building an issue into a pull request, shaping an agent-mode issue into tickets, or repairing the
 * issue's stuck pull request.
 */
export type RunKind = 'build' | 'shape' | 'repair';

/** What any run ends with. */
export type RunResult = PipelineResult | ShapingResult | RepairResult;

/**
 * Every run phat-mode started, newest last per issue. Stored on the root conversation. `kind`: missing in records from
 * before shaping, which were all builds.
 */
export const RunsDoc = defineDoc<{ runs: Record<string, { taskId: number; startedAt: number; kind?: RunKind }[]> }>({
  kind: 'phat.runs',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ runs: {} }),
});

export const runKey = (input: PipelineInput) => `${input.repo}#${input.issue}`;

export function createCopilotModels(credentials: CredentialStore): Models {
  const models = createModels({ credentials });
  models.setProvider(githubCopilotProvider());
  return models;
}

/** One project, open: its lock held, its database open. */
export type PhatMode = {
  /** The project ("owner/name"). */
  repo: string;
  harness: Harness;
  root: Conversation;
  /**
   * Start a run for an issue of this project, or return the one still running for it, whatever its kind. `kind`: build
   * (default), shape or repair. Rejects an issue of another project.
   */
  start(input: PipelineInput, context: Context, kind?: RunKind): Promise<{ taskId: TaskId<RunResult>; resumed: boolean }>;
  close(context: Context): Promise<void>;
};

export type OpenOptions = {
  /**
   * Pi Durable storage has no cross-process locking: a project's database must only ever be open in one process. This
   * lock, the project's, enforces that, and shows what the run is doing. Default: `<home>/locks/<owner>__<name>.lock`.
   * `false` only for storage that is not shared, such as in-memory storage.
   */
  lock?: { path?: string; command?: string } | false;
  /** Opens the storage; called only once the lock is held. Default: SQLite at `<home>/state/<owner>__<name>.sqlite`. */
  storage?: () => Promise<Storage>;
  models?: Models;
  onReport?: (error: unknown) => void;
};

/** What phat-mode needs to open a project: where it lives, which project, and how to get its services. */
export type Setup = {
  /** `<home>`: locks, databases and credentials. */
  home: string;
  /** The project ("owner/name") to open: its lock is taken and its database opened. */
  repo: string;
  /** The services for a repo; called once, when a run needs them. */
  servicesFor: (repo: string) => Promise<Services>;
};

/** What opening the durable state needs, whatever it holds: one project's runs, or the old shared database's. */
export type HarnessSetup = {
  home: string;
  /** The project whose runs the storage holds; undefined for the old shared database. */
  repo?: string;
  servicesFor: (repo: string) => Promise<Services>;
  storage: Storage;
  models?: Models;
  onReport?: (error: unknown) => void;
  /** Told as each phase of a run starts, with the run's kind; the phase waits for it. See OnPhase. */
  onPhase?: (input: PipelineInput, kind: RunKind, phase: string, taskId: TaskId, signal: AbortSignal) => void | Promise<void>;
};

/**
 * Open the harness on `storage`, with every task phat-mode defines. Nothing runs until `harness.resume()`. Internal:
 * callers hold whatever lock protects the storage. Closes nothing on failure, except the harness it opened.
 */
export async function openHarness(setup: HarnessSetup, context: Context) {
  const { onPhase } = setup;
  const { Pipeline, extension } = createPipeline(setup.servicesFor, onPhase && ((input, phase, id, signal) => onPhase(input, 'build', phase, id, signal)));
  const shaping = createShaping(setup.servicesFor, onPhase && ((input, phase, id, signal) => onPhase(input, 'shape', phase, id, signal)));
  const repair = createRepair(setup.servicesFor, onPhase && ((input, phase, id, signal) => onPhase(input, 'repair', phase, id, signal)));
  const registry = createRegistry();
  registry.install(Tools);
  registry.install(guardFor(setup.repo));
  registry.install(Skills);
  registry.install(extension);
  registry.install(shaping.extension);
  registry.install(repair.extension);

  const models = setup.models ?? createCopilotModels(new FileCredentialStore(paths.credentials({ home: setup.home })));
  const shellEnv = agentEnv();
  const harness = await Harness.open(
    setup.storage,
    {
      models,
      registry,
      // Each agent's tools run in its issue's workspace, without the user's tokens in the environment.
      env: ({ cwd }) => (cwd === undefined ? undefined : new NodeExecutionEnv({ cwd, shellEnv })),
      settings: { retry: { maxRetries: 3 }, stream: { timeoutMs: 300_000 } },
      onReport: (error) => setup.onReport?.(error),
    },
    context,
  );
  try {
    const root = await harness.root(context);
    return { harness, root, Pipeline, Shaping: shaping.Shaping, Repair: repair.Repair };
  } catch (error) {
    await harness.close(context).catch(() => {});
    throw error;
  }
}

/**
 * Open one project: take its lock first, so no other process ever has its database open, then open its database. Throws
 * LockedError, without opening anything, when another live process holds it.
 */
export async function openPhatMode(setup: Setup, context: Context, options: OpenOptions = {}): Promise<PhatMode> {
  const { home, repo } = setup;
  const lock =
    options.lock === false
      ? undefined
      : await acquireLock(
          options.lock?.path ?? paths.projectLock(home, repo),
          options.lock?.command ?? 'phat-mode',
          { what: repo },
        );

  // One run at a time per project: resuming a harness lets every pending run go ahead, so each run waits here, as its
  // phases start, until the run holding the slot has settled. The lock file says what the slot's run is doing.
  let slot: { taskId: TaskId; settled: Promise<void> } | undefined;
  const show = (doing: Doing | undefined) => lock?.update(doing).catch((error) => options.onReport?.(error));
  async function takeSlot(taskId: TaskId, signal: AbortSignal) {
    while (slot !== undefined && slot.taskId !== taskId) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        signal.addEventListener('abort', done, { once: true });
        void slot!.settled.then(done);
      });
    }
    signal.throwIfAborted();
    if (slot !== undefined) return;
    const settled = opened.harness.waitForTask(taskId, context).then(
      () => {},
      () => {},
    );
    const mine = { taskId, settled };
    slot = mine;
    // Once the run settles (finished, failed or aborted, or the project is closed), the project is free again.
    void settled.then(async () => {
      if (slot !== mine) return;
      slot = undefined;
      await show(undefined);
    });
  }

  let opened: Awaited<ReturnType<typeof openHarness>>;
  try {
    const storage = await (options.storage ??
      (async () => {
        await mkdir(paths.stateDir(home), { recursive: true });
        return openNodeSqliteStorage(paths.projectState(home, repo));
      }))();
    opened = await openHarness(
      {
        home,
        repo,
        servicesFor: setup.servicesFor,
        storage,
        models: options.models,
        onReport: options.onReport,
        onPhase: async (input, kind, phase, taskId, signal) => {
          await takeSlot(taskId, signal);
          await show({ issue: input.issue, kind, phase });
        },
      },
      context,
    );
  } catch (error) {
    await lock?.release();
    throw error;
  }
  const { harness, root, Pipeline, Shaping, Repair } = opened;

  async function start(input: PipelineInput, context: Context, kind: RunKind = 'build') {
    if (input.repo !== repo) throw new Error(`This is ${repo}'s state; ${input.repo} has its own.`);
    const key = runKey(input);
    const runs = (await harness.snapshot(RunsDoc, root.id, context))?.runs[key] ?? [];
    const latest = runs.at(-1);
    if (latest !== undefined) {
      const record = await harness.getTask(latest.taskId as unknown as TaskId<RunResult>, context);
      if (record !== undefined && record.state.status !== 'terminal') {
        return { taskId: latest.taskId as unknown as TaskId<RunResult>, resumed: true };
      }
    }
    const taskId = await root.commit(async (tx) => {
      // Background: runs for different issues never block each other or the root conversation.
      const options = { ownership: { kind: 'conversation' as const }, background: true };
      const id = (
        kind === 'shape'
          ? await tx.createTask(Shaping, input, options)
          : kind === 'repair'
            ? await tx.createTask(Repair, input, options)
            : await tx.createTask(Pipeline, input, options)
      ) as TaskId<RunResult>;
      const doc = await tx.doc(RunsDoc, root.id);
      // Assign a new list: documents track assignments, not mutations of a detached array.
      doc.runs[key] = [...(doc.runs[key] ?? []), { taskId: id, startedAt: Date.now(), kind }];
      return id;
    }, context);
    return { taskId, resumed: false };
  }

  let closed: Promise<void> | undefined;
  const close = (context: Context) =>
    (closed ??= (async () => {
      try {
        await harness.close(context);
      } finally {
        await lock?.release();
      }
    })());

  return { repo, harness, root, start, close };
}
