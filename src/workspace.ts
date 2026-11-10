import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { branchFor } from './config.ts';
import { CommandError, run, runShell, type RunResult } from './exec.ts';

/** Where the planner and implementer keep downloads and working files: next to the workspace, never committed. */
export const scratchFor = (workspace: string) => `${workspace}-scratch`;

/**
 * What a folder in a project's workspaces folder is, by its name: an issue's build workspace (`issue-<n>`), its scratch
 * folder (`issue-<n>-scratch`), its shaping checkout (`shape-<n>`), the "before" evidence checkout (`base`), or unknown.
 */
export type WorkspaceFolder = { name: string; kind: 'build' | 'scratch' | 'shape' | 'base' | 'unknown'; issue?: number };

/** What `remove` takes away: an issue's build workspace with its scratch folder, or its shaping checkout. */
export type WorkspaceTarget = { kind: 'build' | 'shape'; issue: number };

/** The folders `remove` took away (or would, on a dry run), and their size on disk. */
export type WorkspaceRemoval = { paths: string[]; bytes: number };

/** Git work for one issue. Pipeline code calls these, never the model. */
export interface Workspaces {
  /**
   * Clone or update the repository and check out the issue's branch, fresh from the base branch, in its own directory:
   * any workspace and scratch folder an earlier run left for the issue are removed first. Only a new run calls it (a
   * resumed run keeps the workspace it made), so nothing an earlier run left carries over.
   */
  prepare(issue: number): Promise<string>;
  /**
   * As `prepare`, but the issue's branch starts at `sha`, the head of its pull request as fetched from origin, instead
   * of the base branch: a fresh workspace for repairing the pull request.
   */
  checkout(issue: number, sha: string): Promise<string>;
  /** Every entry directly in the project's workspaces folder, by kind. Empty when there is none. */
  folders(): Promise<WorkspaceFolder[]>;
  /**
   * Remove an issue's build workspace (the git worktree, through git, and its scratch folder) or its shaping checkout.
   * Never removes anything outside the project's workspaces folder, never follows a symlink out of it, and keeps the
   * issue's branch. `dryRun`: only measure. Returns the folders that were there, and their size.
   */
  remove(target: WorkspaceTarget, options?: { dryRun?: boolean }): Promise<WorkspaceRemoval>;
  /**
   * The commit of the base branch the work is based on: where the branch last met it (`git merge-base`). Fixed while
   * `origin/<base>` moves on, until the base branch is merged in, so reviewers never see newer commits on it as part of
   * this change.
   */
  base(workspace: string): Promise<string>;
  /** Changes against `base`, committed or not, including new files. */
  diff(workspace: string): Promise<string>;
  /** Changes a fingerprint whenever any file in the workspace changes. */
  fingerprint(workspace: string): Promise<string>;
  /** Commit everything. Returns false when there was nothing to commit. */
  commitAll(workspace: string, message: string): Promise<boolean>;
  /** Commits on the issue branch that are not on the base branch. */
  commitsAhead(workspace: string): Promise<number>;
  /** Push the issue branch. Returns the commit pushed. */
  push(workspace: string, issue: number): Promise<string>;
  /**
   * Push the issue branch only over `lease`, the commit the branch must still be at on origin (never over anything
   * pushed since, whatever the clone last fetched). Returns the commit pushed; also when origin already has it (pushed
   * before a crash). Undefined when the branch has moved on from `lease`: nothing is pushed.
   */
  pushOver(workspace: string, issue: number, lease: string): Promise<string | undefined>;
  /** The commit checked out in the workspace. */
  head(workspace: string): Promise<string>;
  /**
   * Bring the branch up to date with the base branch, as GitHub's "Update branch" does: commit everything with
   * `message`, fetch, and merge `origin/<base>` in. Returns the files with conflicts, left with conflict markers and the
   * merge in progress for `finishMerge`; empty when it merged or was up to date. Resumed with a merge still in
   * progress, returns its conflicts again without committing anything.
   */
  updateBranch(workspace: string, message: string): Promise<string[]>;
  /**
   * Commit a merge `updateBranch` left in progress, once no file has conflict markers left. Returns the files that
   * still do (the merge stays in progress); empty when there was no merge or it is committed.
   */
  finishMerge(workspace: string): Promise<string[]>;
  /** A clean checkout of `ref` (default: the base branch), for "before" evidence. One per repository, reset on every call. */
  prepareBase(ref?: string): Promise<string>;
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
  /**
   * The ADRs and glossaries (`GLOSSARY.md`, `CONTEXT.md`) added or changed on the base branch after `since` (an ISO
   * time), up to `base(workspace)`, oldest first. Only commits on the base branch's first-parent line count, each at its
   * committer time, with the diff it brought in; deletions are left out, and a rename counts as added.
   */
  docChanges(workspace: string, since: string): Promise<DocChange[]>;
}

/** An ADR or glossary file a commit on the base branch added or changed. `title`: an ADR's first `# ` heading. */
export type DocChange = { path: string; kind: 'added' | 'changed'; title?: string; sha: string; subject: string };

/** The repo's install command failed: the repo's problem, not a passing one such as being offline. */
export class InstallError extends Error {
  constructor(command: string, cause: CommandError) {
    super(`\`${command}\` failed (exit ${cause.result.code}):\n\n\`\`\`\n${tail(`${cause.result.stdout}\n${cause.result.stderr}`, 3000)}\n\`\`\``);
  }
}

/** Evidence branch: verification evidence lives here, never on the pull request's branch. */
export const EVIDENCE_BRANCH = 'phat-mode/evidence';
const SNAPSHOT_MESSAGE = 'phat-mode: snapshot before verification';
/** A line git writes around a conflict: `<<<<<<< ours` or `>>>>>>> theirs`. (`=======` alone is too common to count.) */
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

/** An ADR: a Markdown file directly in a `docs/adr/` folder, at any depth (multi-context repos have one per context). */
const isAdrPath = (path: string) => /(^|\/)docs\/adr\/[^/]+\.md$/.test(path) && basename(path) !== 'README.md';
/** The files that count as changed domain docs: ADRs and glossaries. Other docs change in nearly every commit. */
const isDocPath = (path: string) => isAdrPath(path) || ['GLOSSARY.md', 'CONTEXT.md'].includes(basename(path));

/**
 * One line of `git log --name-status --diff-filter=AMR` (`M\tpath`, `R087\told\tnew`) as a domain doc change, or
 * undefined when it is not an ADR or glossary. A rename counts as added, at its new path.
 */
export function docChangeOf(line: string): { path: string; kind: 'added' | 'changed'; doc: 'adr' | 'glossary' } | undefined {
  const [status = '', ...paths] = line.split('\t');
  const path = paths.at(-1);
  if (path === undefined || !isDocPath(path)) return undefined;
  return { path, kind: status.startsWith('M') ? 'changed' : 'added', doc: isAdrPath(path) ? 'adr' : 'glossary' };
}

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
  /**
   * The project's workspaces folder, `workspaces/<owner>__<name>/`: the only place `remove` removes anything from.
   * Default: the folder of `workspaceDir`'s workspaces.
   */
  workspacesRoot?: string;
  installCommand?: string;
  installTimeoutMs?: number;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * The names phat-mode gives an issue's folders: `issue-<n>` (build), `issue-<n>-scratch` (scratch), `shape-<n>`
 * (shape). Undefined for any other name. The only names `remove` ever removes.
 */
function parseIssueFolder(name: string): { kind: 'build' | 'scratch' | 'shape'; issue: number } | undefined {
  const match = /^(issue-(\d+)(-scratch)?|shape-(\d+))$/.exec(name);
  if (match === null) return undefined;
  if (match[4] !== undefined) return { kind: 'shape', issue: Number(match[4]) };
  return { kind: match[3] === undefined ? 'build' : 'scratch', issue: Number(match[2]) };
}

/** A folder's kind, by its name. `base`: the name of the "before" evidence checkout. */
export function classifyFolder(name: string, base = 'base'): WorkspaceFolder {
  if (name === base) return { name, kind: 'base' };
  return { name, ...(parseIssueFolder(name) ?? { kind: 'unknown' }) };
}

const missingAsUndefined = <T>(promise: Promise<T>): Promise<T | undefined> =>
  promise.catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));

/** Size on disk of `path`, without following symlinks (`du` does not); 0 when it is gone. */
async function sizeOf(path: string): Promise<number> {
  const du = await run('du', ['-sk', path], { allowFailure: true });
  const kilobytes = Number.parseInt(du.stdout.trim().split(/\s/)[0] ?? '', 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
}

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

  async prepareBase(ref?: string): Promise<string> {
    return this.#detachedCheckout(this.#baseDir, ref);
  }

  #shapeDir(issue: number): string {
    const { shapeWorkspaceDir, workspaceDir } = this.#options;
    return shapeWorkspaceDir?.(issue) ?? join(dirname(workspaceDir(issue)), `shape-${issue}`);
  }

  get #root(): string {
    return this.#options.workspacesRoot ?? dirname(this.#options.workspaceDir(0));
  }

  async folders(): Promise<WorkspaceFolder[]> {
    const root = await this.#trustedRoot();
    if (root === undefined) return [];
    const names = await readdir(root);
    const base = basename(this.#baseDir);
    return names.sort().map((name) => classifyFolder(name, base));
  }

  async remove(target: WorkspaceTarget, options: { dryRun?: boolean } = {}): Promise<WorkspaceRemoval> {
    const workspace = this.#options.workspaceDir(target.issue);
    const candidates = target.kind === 'build' ? [workspace, scratchFor(workspace)] : [this.#shapeDir(target.issue)];
    const removal: WorkspaceRemoval = { paths: [], bytes: 0 };
    for (const path of candidates) {
      const entry = await this.#checked(path);
      if (entry === undefined) continue;
      removal.paths.push(path);
      if (!entry.isSymbolicLink()) removal.bytes += await sizeOf(path);
      if (!options.dryRun) await this.#removePath(path, entry.isSymbolicLink());
    }
    return removal;
  }

  /**
   * What is at `path`, without following it; undefined when nothing is. Throws unless `path` is directly in the
   * project's workspaces folder (its real location, symlinks resolved) under a name `remove` may remove.
   */
  async #checked(path: string) {
    if (parseIssueFolder(basename(path)) === undefined) throw new Error(`Not a workspace phat-mode removes: ${path}`);
    const root = await this.#trustedRoot();
    if (root === undefined) return undefined;
    if ((await missingAsUndefined(realpath(dirname(path)))) !== root) throw new Error(`Not in ${this.#root}: ${path}`);
    return missingAsUndefined(lstat(path));
  }

  /**
   * The real path of the project's workspaces folder (`<home>/workspaces/<owner>__<name>`); undefined when there is
   * none. `<home>` is the trusted boundary: the `workspaces` and `<owner>__<name>` folders below it must each be a real
   * folder of its own, never a symlink, or this throws, so nothing is ever listed or removed through a redirection.
   */
  async #trustedRoot(): Promise<string | undefined> {
    const root = this.#root;
    const parent = dirname(root);
    const home = dirname(parent);
    for (const dir of [parent, root]) {
      const entry = await missingAsUndefined(lstat(dir));
      if (entry === undefined) return undefined;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`${dir} is a symlink or not a folder: phat-mode lists and removes nothing in ${root}`);
      }
    }
    const real = await realpath(root);
    const expected = join(await realpath(home), basename(parent), basename(root));
    if (real !== expected) {
      throw new Error(`${root} resolves to ${real}, through a symlink: phat-mode lists and removes nothing in it`);
    }
    return real;
  }

  /**
   * Remove a checked path. A symlink: only the link. A folder: write permission back on its folders (a shaping checkout
   * is read-only; `find -type d` never matches a symlink, so nothing outside is touched), a worktree removed through git,
   * then whatever is left (`rm` does not follow symlinks), and the clone's worktree list pruned. Branches stay.
   */
  async #removePath(path: string, symlink: boolean): Promise<void> {
    if (symlink) {
      await unlink(path);
      return;
    }
    const { cloneDir } = this.#options;
    await run('find', [path, '-type', 'd', '!', '-perm', '-u+w', '-exec', 'chmod', 'u+w', '{}', '+'], { allowFailure: true });
    const clone = await exists(join(cloneDir, '.git'));
    if (clone && (await exists(join(path, '.git')))) {
      await this.#git(cloneDir, ['worktree', 'remove', '--force', '--force', path], true);
    }
    await rm(path, { recursive: true, force: true });
    if (clone) await this.#git(cloneDir, ['worktree', 'prune']);
  }

  async prepareShaping(issue: number): Promise<string> {
    const dir = this.#shapeDir(issue);
    // Writable while it is reset and installed, read-only for the agents.
    await this.#setReadOnly(dir, false);
    await this.#detachedCheckout(dir);
    await this.#setReadOnly(dir, true);
    return dir;
  }

  /** A clean, detached checkout of `ref` (default: the base branch) in `baseDir`, reset if it is there; installs when needed. */
  async #detachedCheckout(baseDir: string, ref = this.#base): Promise<string> {
    const cloneDir = await this.#ensureClone();
    let reinstall = !(await exists(join(baseDir, 'node_modules')));
    if (!(await exists(join(baseDir, '.git')))) {
      await mkdir(dirname(baseDir), { recursive: true });
      await this.#git(cloneDir, ['worktree', 'prune']);
      await this.#git(cloneDir, ['worktree', 'add', '--detach', baseDir, ref]);
    } else {
      const before = (await this.#git(baseDir, ['rev-parse', 'HEAD'])).stdout.trim();
      await this.#git(baseDir, ['checkout', '--detach', '--force', ref]);
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
    return this.#freshWorkspace(issue, this.#base);
  }

  async checkout(issue: number, sha: string): Promise<string> {
    return this.#freshWorkspace(issue, sha);
  }

  /** The issue's workspace, fresh, on its branch starting at `start`. The clone is fetched first. */
  async #freshWorkspace(issue: number, start: string): Promise<string> {
    const cloneDir = await this.#ensureClone();

    const workspace = this.#options.workspaceDir(issue);
    // A fresh start: whatever an earlier run of this issue left, on its branch or in its scratch folder, goes.
    await this.remove({ kind: 'build', issue });
    await mkdir(dirname(workspace), { recursive: true });
    await this.#git(cloneDir, ['worktree', 'prune']);
    await this.#git(cloneDir, ['worktree', 'add', '-B', branchFor(issue), workspace, start]);
    await this.#install(workspace);
    return workspace;
  }

  async base(workspace: string): Promise<string> {
    return (await this.#git(workspace, ['merge-base', 'HEAD', this.#base])).stdout.trim();
  }

  async docChanges(workspace: string, since: string): Promise<DocChange[]> {
    const after = Date.parse(since);
    const base = await this.base(workspace);
    const log = await this.#git(workspace, [
      'log', '--first-parent', '--diff-merges=first-parent', '--reverse', '--name-status', '--diff-filter=AMR',
      '--format=%x00%H%x1f%h%x1f%cI%x1f%s', base, '--',
      ':(glob)**/docs/adr/**', ':(glob)**/GLOSSARY.md', ':(glob)**/CONTEXT.md',
    ]);
    const changes: DocChange[] = [];
    for (const entry of log.stdout.split('\0').slice(1)) {
      const [header = '', ...files] = entry.split('\n');
      const [full = '', sha = '', committed = '', subject = ''] = header.split('\x1f');
      if (!(Date.parse(committed) > after)) continue;
      for (const line of files) {
        const change = docChangeOf(line);
        if (change === undefined) continue;
        const { path, kind } = change;
        const title = change.doc === 'adr' ? await this.#adrTitle(workspace, full, path) : undefined;
        changes.push({ path, kind, ...(title === undefined ? {} : { title }), sha, subject });
      }
    }
    return changes;
  }

  /** An ADR's title: its first `# ` heading, else its file name. */
  async #adrTitle(workspace: string, commit: string, path: string): Promise<string> {
    const shown = await this.#git(workspace, ['show', `${commit}:${path}`], true);
    return /^# +(.+?)\s*$/m.exec(shown.stdout)?.[1] ?? basename(path, '.md');
  }

  async diff(workspace: string): Promise<string> {
    const base = await this.base(workspace);
    // Mark new files so the diff includes them, without staging their content.
    await this.#git(workspace, ['add', '--all', '--intent-to-add']);
    return (await this.#git(workspace, ['diff', base])).stdout;
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

  async push(workspace: string, issue: number): Promise<string> {
    const branch = branchFor(issue);
    const head = (await this.#git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
    await this.#git(workspace, ['push', '--force-with-lease', '--set-upstream', 'origin', `${head}:refs/heads/${branch}`]);
    return head;
  }

  async pushOver(workspace: string, issue: number, lease: string): Promise<string | undefined> {
    const branch = branchFor(issue);
    const head = await this.head(workspace);
    const onOrigin = async () =>
      (await this.#git(workspace, ['ls-remote', 'origin', `refs/heads/${branch}`])).stdout.split('\t')[0]!.trim();
    const before = await onOrigin();
    if (before === head) return head;
    if (before !== lease) return undefined;
    const pushed = await this.#git(
      workspace,
      ['push', `--force-with-lease=refs/heads/${branch}:${lease}`, 'origin', `${head}:refs/heads/${branch}`],
      true,
    );
    if (pushed.code === 0) return head;
    // Someone pushed between the look and the push: theirs stays.
    if ((await onOrigin()) !== lease) return undefined;
    throw new Error(`Could not push ${branch}: ${`${pushed.stdout}\n${pushed.stderr}`.trim()}`);
  }

  async head(workspace: string): Promise<string> {
    return (await this.#git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  async #merging(workspace: string): Promise<boolean> {
    return (await this.#git(workspace, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], true)).code === 0;
  }

  async #lines(workspace: string, args: string[]): Promise<string[]> {
    const { stdout } = await this.#git(workspace, args);
    return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  }

  async updateBranch(workspace: string, message: string): Promise<string[]> {
    if (await this.#merging(workspace)) {
      const unmerged = await this.#lines(workspace, ['diff', '--name-only', '--diff-filter=U']);
      return [...new Set([...unmerged, ...(await this.#withMarkers(workspace))])].sort();
    }
    await this.commitAll(workspace, message);
    await this.#ensureClone();
    const upToDate = await this.#git(workspace, ['merge-base', '--is-ancestor', this.#base, 'HEAD'], true);
    if (upToDate.code === 0) return [];
    const merged = await this.#git(workspace, ['merge', '--no-edit', '--no-verify', this.#base], true);
    if (merged.code === 0) return [];
    const conflicts = await this.#lines(workspace, ['diff', '--name-only', '--diff-filter=U']);
    if (conflicts.length === 0) {
      await this.#git(workspace, ['merge', '--abort'], true);
      throw new Error(`Could not merge ${this.#base}: ${`${merged.stdout}\n${merged.stderr}`.trim()}`);
    }
    return conflicts;
  }

  async finishMerge(workspace: string): Promise<string[]> {
    if (!(await this.#merging(workspace))) return [];
    const left = await this.#withMarkers(workspace);
    if (left.length > 0) return left;
    await this.#git(workspace, ['add', '--all']);
    await this.#git(workspace, ['commit', '--no-verify', '--no-edit']);
    return [];
  }

  /**
   * Changed files (against HEAD, or new) that still have a conflict marker line. A conflict git cannot mark (deleted on
   * one side, or a binary file) is taken as the implementer left it.
   */
  async #withMarkers(workspace: string): Promise<string[]> {
    const changed = [
      ...(await this.#lines(workspace, ['diff', '--name-only', 'HEAD'])),
      ...(await this.#lines(workspace, ['ls-files', '--others', '--exclude-standard'])),
    ];
    const marked: string[] = [];
    for (const path of new Set(changed)) {
      const text = await readFile(join(workspace, path), 'utf8').catch(() => '');
      if (CONFLICT_MARKER.test(text)) marked.push(path);
    }
    return marked.sort();
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
