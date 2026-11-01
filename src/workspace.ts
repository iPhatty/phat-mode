import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { branchFor } from './config.ts';
import { CommandError, run, runShell, type RunResult } from './exec.ts';

/** Git work for one issue. Pipeline code calls these, never the model. */
export interface Workspaces {
  /** Clone or update the repository and check out the issue's branch in its own directory. Safe to repeat. */
  prepare(issue: number): Promise<string>;
  /** Changes against the base branch, including new files. */
  diff(workspace: string): Promise<string>;
  /** Changes a fingerprint whenever any file in the workspace changes. */
  fingerprint(workspace: string): Promise<string>;
  /** Commit everything. Returns false when there was nothing to commit. */
  commitAll(workspace: string, message: string): Promise<boolean>;
  /** Commits on the issue branch that are not on the base branch. */
  commitsAhead(workspace: string): Promise<number>;
  push(workspace: string, issue: number): Promise<void>;
  /** A clean checkout of the base branch, for "before" evidence. One per repository, reset on every call. */
  prepareBase(): Promise<string>;
  /**
   * A clean, detached checkout of the base branch for shaping an issue: no branch, so it never clashes with a later
   * build of the same issue. Reset on every call; dependencies installed once. Its files and folders are read-only
   * (`node_modules` aside), so commands the agents run cannot change them. An `InstallError` when installing fails.
   */
  prepareShaping(issue: number): Promise<string>;
  /**
   * Commit the current state locally (never pushed), so restoreSnapshot can throw away whatever an agent changes
   * afterwards. Safe to repeat.
   */
  snapshot(workspace: string): Promise<void>;
  /** Discard changes made since snapshot, and uncommit the snapshot. Returns the paths that were discarded. */
  restoreSnapshot(workspace: string): Promise<string[]>;
  /** Uncommit a snapshot left behind, e.g. by a crash. Safe when there is none. */
  undoSnapshot(workspace: string): Promise<void>;
  /** Commit files to the evidence branch and push it. Returns the commit. */
  publishEvidence(files: readonly EvidenceFile[]): Promise<string>;
}

/** The repo's install command failed: the repo's problem, not a passing one such as being offline. */
export class InstallError extends Error {
  constructor(command: string, cause: CommandError) {
    super(`\`${command}\` failed (exit ${cause.result.code}):\n\n\`\`\`\n${tail(`${cause.result.stdout}\n${cause.result.stderr}`, 3000)}\n\`\`\``);
  }
}

/** Evidence branch: verification evidence lives here, never on the pull request's branch. */
export const EVIDENCE_BRANCH = 'phat-mode/evidence';
const SNAPSHOT_MESSAGE = 'phat-mode: snapshot before verification';

/** `source`: a local file. `path`: where it goes on the evidence branch. */
export type EvidenceFile = { source: string; path: string };

export type GitWorkspacesOptions = {
  /** Clone source, e.g. `https://github.com/owner/name.git` or a local path in tests. */
  remoteUrl: string;
  baseBranch: string;
  cloneDir: string;
  workspaceDir: (issue: number) => string;
  /** The base branch checkout for "before" evidence. Default: next to cloneDir. */
  baseWorkspaceDir?: string;
  /** The checkout for shaping an issue. Default: `shape-<issue>` next to the issue's workspace. */
  shapeWorkspaceDir?: (issue: number) => string;
  installCommand?: string;
  installTimeoutMs?: number;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export class GitWorkspaces implements Workspaces {
  readonly #options: GitWorkspacesOptions;

  constructor(options: GitWorkspacesOptions) {
    this.#options = options;
  }

  #git(cwd: string, args: string[], allowFailure = false): Promise<RunResult> {
    return run('git', args, { cwd, allowFailure });
  }

  get #base() {
    return `origin/${this.#options.baseBranch}`;
  }

  async #ensureClone(): Promise<string> {
    const { cloneDir, remoteUrl } = this.#options;
    if (!(await exists(join(cloneDir, '.git')))) {
      await mkdir(dirname(cloneDir), { recursive: true });
      await run('git', ['clone', remoteUrl, cloneDir]);
    }
    await this.#git(cloneDir, ['fetch', '--prune', 'origin']);
    return cloneDir;
  }

  async #install(workspace: string): Promise<void> {
    const { installCommand, installTimeoutMs } = this.#options;
    if (installCommand === undefined) return;
    try {
      await runShell(installCommand, { cwd: workspace, timeoutMs: installTimeoutMs });
    } catch (error) {
      if (error instanceof CommandError) throw new InstallError(installCommand, error);
      throw error;
    }
  }

  /**
   * Make the checkout's own files and folders read-only, or writable again. `node_modules` keeps its permissions, so
   * tools may still write their caches there; `.git` (a file pointing into the clone) is left alone.
   */
  async #setReadOnly(dir: string, readOnly: boolean): Promise<void> {
    if (!(await exists(dir))) return;
    const skip = ['-path', join(dir, 'node_modules'), '-prune', '-o', '-path', join(dir, '.git'), '-prune', '-o'];
    await run('find', [dir, ...skip, '-exec', 'chmod', readOnly ? 'a-w' : 'u+w', '{}', '+']);
  }

  get #baseDir() {
    return this.#options.baseWorkspaceDir ?? `${this.#options.cloneDir}-base`;
  }

  async prepareBase(): Promise<string> {
    return this.#detachedCheckout(this.#baseDir);
  }

  async prepareShaping(issue: number): Promise<string> {
    const { shapeWorkspaceDir, workspaceDir } = this.#options;
    const dir = shapeWorkspaceDir?.(issue) ?? join(dirname(workspaceDir(issue)), `shape-${issue}`);
    // Writable while it is reset and installed, read-only for the agents.
    await this.#setReadOnly(dir, false);
    await this.#detachedCheckout(dir);
    await this.#setReadOnly(dir, true);
    return dir;
  }

  /** A clean, detached checkout of the base branch in `baseDir`, reset if it is there; installs when needed. */
  async #detachedCheckout(baseDir: string): Promise<string> {
    const cloneDir = await this.#ensureClone();
    let reinstall = !(await exists(join(baseDir, 'node_modules')));
    if (!(await exists(join(baseDir, '.git')))) {
      await mkdir(dirname(baseDir), { recursive: true });
      await this.#git(cloneDir, ['worktree', 'prune']);
      await this.#git(cloneDir, ['worktree', 'add', '--detach', baseDir, this.#base]);
    } else {
      const before = (await this.#git(baseDir, ['rev-parse', 'HEAD'])).stdout.trim();
      await this.#git(baseDir, ['checkout', '--detach', '--force', this.#base]);
      // Untracked files go; ignored ones (node_modules, evidence) stay.
      await this.#git(baseDir, ['clean', '-fd']);
      const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
      const changed = await this.#git(baseDir, ['diff', '--quiet', before, 'HEAD', '--', ...lockfiles], true);
      if (changed.code !== 0) reinstall = true;
    }
    if (reinstall) await this.#install(baseDir);
    return baseDir;
  }

  async snapshot(workspace: string): Promise<void> {
    if (await this.#isSnapshot(workspace)) return; // Resumed: the snapshot is already there.
    await this.#git(workspace, ['add', '--all']);
    if ((await this.#git(workspace, ['diff', '--cached', '--quiet'], true)).code === 0) return;
    await this.#git(workspace, ['commit', '--no-verify', '--quiet', '-m', SNAPSHOT_MESSAGE]);
  }

  async restoreSnapshot(workspace: string): Promise<string[]> {
    const status = await this.#git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
    const changed = status.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '');
    await this.#git(workspace, ['reset', '--hard', '--quiet', 'HEAD']);
    await this.#git(workspace, ['clean', '-fd', '--quiet']);
    await this.undoSnapshot(workspace);
    return changed;
  }

  async undoSnapshot(workspace: string): Promise<void> {
    if (await this.#isSnapshot(workspace)) await this.#git(workspace, ['reset', '--mixed', '--quiet', 'HEAD~1']);
  }

  async #isSnapshot(workspace: string): Promise<boolean> {
    const subject = await this.#git(workspace, ['log', '-1', '--format=%s'], true);
    return subject.code === 0 && subject.stdout.trim() === SNAPSHOT_MESSAGE;
  }

  async publishEvidence(files: readonly EvidenceFile[]): Promise<string> {
    const cloneDir = await this.#ensureClone();
    const scratch = await mkdtemp(join(tmpdir(), 'phat-evidence-'));
    // Its own index, so the clone's checkout is never touched.
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_AUTHOR_NAME: 'phat-mode',
      GIT_AUTHOR_EMAIL: 'phat-mode@localhost',
      GIT_COMMITTER_NAME: 'phat-mode',
      GIT_COMMITTER_EMAIL: 'phat-mode@localhost',
    };
    const git = (args: string[], allowFailure = false) => run('git', args, { cwd: cloneDir, env, allowFailure });
    try {
      for (let attempt = 1; ; attempt++) {
        await git(['fetch', 'origin', `+refs/heads/${EVIDENCE_BRANCH}:refs/remotes/origin/${EVIDENCE_BRANCH}`], true);
        const parent = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${EVIDENCE_BRANCH}`], true);
        await rm(env.GIT_INDEX_FILE, { force: true });
        if (parent.code === 0) await git(['read-tree', parent.stdout.trim()]);
        for (const file of files) {
          const blob = (await git(['hash-object', '-w', '--', file.source])).stdout.trim();
          await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`]);
        }
        const tree = (await git(['write-tree'])).stdout.trim();
        const parents = parent.code === 0 ? ['-p', parent.stdout.trim()] : [];
        const commit = (await git(['commit-tree', tree, ...parents, '-m', 'phat-mode: verification evidence'])).stdout.trim();
        const pushed = await git(['push', '--quiet', 'origin', `${commit}:refs/heads/${EVIDENCE_BRANCH}`], true);
        if (pushed.code === 0) return commit;
        // Someone else pushed evidence meanwhile: build on theirs.
        if (attempt >= 3) throw new Error(`Could not push evidence: ${pushed.stderr.trim()}`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async prepare(issue: number): Promise<string> {
    const cloneDir = await this.#ensureClone();

    const workspace = this.#options.workspaceDir(issue);
    if (!(await exists(join(workspace, '.git')))) {
      await mkdir(dirname(workspace), { recursive: true });
      await this.#git(cloneDir, ['worktree', 'prune']);
      await this.#git(cloneDir, ['worktree', 'add', '-B', branchFor(issue), workspace, this.#base]);
    }
    if (!(await exists(join(workspace, 'node_modules')))) await this.#install(workspace);
    return workspace;
  }

  async diff(workspace: string): Promise<string> {
    // Mark new files so the diff includes them, without staging their content.
    await this.#git(workspace, ['add', '--all', '--intent-to-add']);
    return (await this.#git(workspace, ['diff', this.#base])).stdout;
  }

  async fingerprint(workspace: string): Promise<string> {
    // diff() marks new files intent-to-add, which changes the status: take the status after it, so the fingerprint
    // only changes when files do.
    const diff = await this.diff(workspace);
    const status = (await this.#git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    return createHash('sha256').update(status).update(diff).digest('hex');
  }

  async commitAll(workspace: string, message: string): Promise<boolean> {
    await this.#git(workspace, ['add', '--all']);
    const staged = await this.#git(workspace, ['diff', '--cached', '--quiet'], true);
    if (staged.code === 0) return false;
    await this.#git(workspace, ['commit', '--no-verify', '-m', message]);
    return true;
  }

  async commitsAhead(workspace: string): Promise<number> {
    const count = await this.#git(workspace, ['rev-list', '--count', `${this.#base}..HEAD`]);
    return Number(count.stdout.trim());
  }

  async push(workspace: string, issue: number): Promise<void> {
    const branch = branchFor(issue);
    await this.#git(workspace, ['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`]);
  }
}

export type CheckResult = {
  passed: boolean;
  /** The end of the output, for the implementer and the PR. */
  output: string;
};

export interface Checks {
  run(workspace: string): Promise<CheckResult>;
}

/** Runs the project's own check command (lint, typecheck, tests). The pipeline decides pass or fail, not the model. */
export class CommandChecks implements Checks {
  readonly #command: string;
  readonly #timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    this.#command = command;
    this.#timeoutMs = timeoutMs;
  }

  async run(workspace: string): Promise<CheckResult> {
    const result = await runShell(this.#command, {
      cwd: workspace,
      timeoutMs: this.#timeoutMs,
      allowFailure: true,
      env: { ...process.env, CI: 'true' },
    });
    return { passed: result.code === 0, output: tail(`${result.stdout}\n${result.stderr}`, 6000) };
  }
}

export function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}
