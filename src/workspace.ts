import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { branchFor } from './config.ts';
import { run, runShell, type RunResult } from './exec.ts';

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
}

export type GitWorkspacesOptions = {
  /** Clone source, e.g. `https://github.com/owner/name.git` or a local path in tests. */
  remoteUrl: string;
  baseBranch: string;
  cloneDir: string;
  workspaceDir: (issue: number) => string;
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

  async prepare(issue: number): Promise<string> {
    const { cloneDir, remoteUrl, installCommand, installTimeoutMs } = this.#options;
    if (!(await exists(join(cloneDir, '.git')))) {
      await mkdir(dirname(cloneDir), { recursive: true });
      await run('git', ['clone', remoteUrl, cloneDir]);
    }
    await this.#git(cloneDir, ['fetch', '--prune', 'origin']);

    const workspace = this.#options.workspaceDir(issue);
    if (!(await exists(join(workspace, '.git')))) {
      await mkdir(dirname(workspace), { recursive: true });
      await this.#git(cloneDir, ['worktree', 'prune']);
      await this.#git(cloneDir, ['worktree', 'add', '-B', branchFor(issue), workspace, this.#base]);
    }
    if (installCommand !== undefined && !(await exists(join(workspace, 'node_modules')))) {
      await runShell(installCommand, { cwd: workspace, timeoutMs: installTimeoutMs });
    }
    return workspace;
  }

  async diff(workspace: string): Promise<string> {
    // Mark new files so the diff includes them, without staging their content.
    await this.#git(workspace, ['add', '--all', '--intent-to-add']);
    return (await this.#git(workspace, ['diff', this.#base])).stdout;
  }

  async fingerprint(workspace: string): Promise<string> {
    const status = (await this.#git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const diff = await this.diff(workspace);
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
