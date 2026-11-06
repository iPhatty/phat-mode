import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { paths } from '../src/config.ts';
import { run } from '../src/exec.ts';
import { scratchFor } from '../src/workspace.ts';
import { fixture } from './fixture.ts';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const git = (cwd: string, args: string[]) => run('git', args, { cwd });
const head = async (cwd: string, ref = 'HEAD') => (await git(cwd, ['rev-parse', ref])).stdout.trim();

describe('GitWorkspaces', () => {
  test('prepare: a new run starts from a fresh checkout of the base branch; nothing an earlier run left carries over', async () => {
    const { services } = await fixture();
    const { workspaces } = services;
    const first = await workspaces.prepare(7);
    await writeFile(join(first, 'left.txt'), 'from the earlier run\n');
    await workspaces.commitAll(first, 'earlier run');
    await writeFile(join(first, 'uncommitted.txt'), 'dirty\n');
    await mkdir(scratchFor(first));
    await writeFile(join(scratchFor(first), 'notes.txt'), 'old notes\n');

    const again = await workspaces.prepare(7);

    assert.equal(again, first);
    assert.equal(await exists(join(again, 'left.txt')), false);
    assert.equal(await exists(join(again, 'uncommitted.txt')), false);
    assert.equal(await exists(join(scratchFor(again), 'notes.txt')), false);
    assert.equal(await head(again), await head(again, 'origin/main'));
    assert.equal(await readFile(join(again, 'README.md'), 'utf8'), '# test\n');
  });

  test('remove build: the worktree and its scratch folder go, through git; the clone no longer lists it; the branch stays', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    const workspace = await workspaces.prepare(7);
    await mkdir(scratchFor(workspace));
    await writeFile(join(scratchFor(workspace), 'notes.txt'), 'notes\n');
    await writeFile(join(workspace, 'untracked.txt'), 'not committed\n');

    const removal = await workspaces.remove({ kind: 'build', issue: 7 });

    assert.deepEqual(removal.paths, [workspace, scratchFor(workspace)]);
    assert.ok(removal.bytes > 0);
    assert.equal(await exists(workspace), false);
    assert.equal(await exists(scratchFor(workspace)), false);
    const clone = paths.repoClone(config);
    const list = (await git(clone, ['worktree', 'list', '--porcelain'])).stdout;
    assert.doesNotMatch(list, /issue-7/);
    assert.equal((await run('git', ['rev-parse', '--verify', 'phat-mode/issue-7'], { cwd: clone, allowFailure: true })).code, 0);
  });

  test('remove shape: a shaping checkout goes despite its read-only files', async () => {
    const { services } = await fixture();
    const { workspaces } = services;
    const checkout = await workspaces.prepareShaping(8);
    await assert.rejects(writeFile(join(checkout, 'README.md'), 'changed'), 'read-only');

    const removal = await workspaces.remove({ kind: 'shape', issue: 8 });

    assert.deepEqual(removal.paths, [checkout]);
    assert.equal(await exists(checkout), false);
  });

  test('a symlink inside a workspace is never followed out of it: what it points to stays, permissions and all', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    const workspace = await workspaces.prepare(7);
    const outside = join(config.home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep me\n');
    await chmod(outside, 0o555);
    await symlink(outside, join(workspace, 'link'));
    await mkdir(scratchFor(workspace));
    await symlink(outside, join(scratchFor(workspace), 'link'));

    await workspaces.remove({ kind: 'build', issue: 7 });

    assert.equal(await exists(workspace), false);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal((await stat(outside)).mode & 0o777, 0o555);
    await chmod(outside, 0o755);
  });

  test('a workspace that is itself a symlink to a folder outside: only the link goes', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    await workspaces.prepare(1); // The project's workspaces folder exists.
    const outside = join(config.home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep me\n');
    const link = paths.workspace(config, 9);
    await symlink(outside, link);

    const removal = await workspaces.remove({ kind: 'build', issue: 9 });

    assert.deepEqual(removal.paths, [link]);
    assert.equal(await exists(link), false);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep me\n');
  });

  test('folders: each entry by its name; removing workspaces leaves the "before" checkout and the evidence alone', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    assert.deepEqual(await workspaces.folders(), [], 'no workspaces folder yet');
    const workspace = await workspaces.prepare(7);
    await mkdir(scratchFor(workspace));
    await workspaces.prepareShaping(8);
    const base = await workspaces.prepareBase();
    const root = join(config.home, 'workspaces', 'test__repo');
    await mkdir(join(root, 'notes'));
    await mkdir(join(root, 'shape-8-scratch'));
    const evidence = paths.evidence(config, 7);
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'after.png'), 'png');

    assert.deepEqual(await workspaces.folders(), [
      { name: 'base', kind: 'base' },
      { name: 'issue-7', kind: 'build', issue: 7 },
      { name: 'issue-7-scratch', kind: 'scratch', issue: 7 },
      { name: 'notes', kind: 'unknown' },
      { name: 'shape-8', kind: 'shape', issue: 8 },
      { name: 'shape-8-scratch', kind: 'unknown' },
    ]);

    await workspaces.remove({ kind: 'build', issue: 7 });
    await workspaces.remove({ kind: 'shape', issue: 8 });
    assert.deepEqual((await workspaces.folders()).map((folder) => folder.name), ['base', 'notes', 'shape-8-scratch']);
    assert.equal(await readFile(join(base, 'README.md'), 'utf8'), '# test\n');
    assert.equal(await readFile(join(evidence, 'after.png'), 'utf8'), 'png');
  });

  test('remove with dryRun: measures what would go, and removes nothing', async () => {
    const { services } = await fixture();
    const { workspaces } = services;
    const workspace = await workspaces.prepare(7);

    const removal = await workspaces.remove({ kind: 'build', issue: 7 }, { dryRun: true });

    assert.deepEqual(removal.paths, [workspace]);
    assert.ok(removal.bytes > 0);
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# test\n');
  });

  test('a project workspaces folder that is a symlink to a folder outside: nothing is listed or removed through it', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    const outside = join(config.home, 'outside');
    await mkdir(join(outside, 'issue-72'), { recursive: true });
    await writeFile(join(outside, 'issue-72', 'keep.txt'), 'keep me\n');
    await mkdir(join(outside, 'shape-73'));
    await chmod(join(outside, 'shape-73'), 0o555);
    const root = paths.workspacesRoot(config.home, config.repo);
    await mkdir(dirname(root), { recursive: true });
    await symlink(outside, root);

    await assert.rejects(workspaces.folders(), /symlink/);
    await assert.rejects(workspaces.remove({ kind: 'build', issue: 72 }), /symlink/);
    await assert.rejects(workspaces.remove({ kind: 'shape', issue: 73 }), /symlink/);

    assert.equal(await readFile(join(outside, 'issue-72', 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal((await stat(join(outside, 'shape-73'))).mode & 0o777, 0o555);
    await chmod(join(outside, 'shape-73'), 0o755);
  });

  test('a workspaces folder (above the project’s) that is a symlink to a folder outside: nothing is listed or removed through it', async () => {
    const { services, config } = await fixture();
    const { workspaces } = services;
    const outside = join(config.home, 'outside');
    const project = join(outside, 'test__repo');
    await mkdir(join(project, 'issue-72'), { recursive: true });
    await writeFile(join(project, 'issue-72', 'keep.txt'), 'keep me\n');
    await mkdir(join(project, 'shape-73'));
    await chmod(join(project, 'shape-73'), 0o555);
    const root = paths.workspacesRoot(config.home, config.repo);
    await symlink(outside, dirname(root));

    await assert.rejects(workspaces.folders(), /symlink/);
    await assert.rejects(workspaces.remove({ kind: 'build', issue: 72 }), /symlink/);
    await assert.rejects(workspaces.remove({ kind: 'shape', issue: 73 }), /symlink/);

    assert.equal(await readFile(join(project, 'issue-72', 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal((await stat(join(project, 'shape-73'))).mode & 0o777, 0o555);
    await chmod(join(project, 'shape-73'), 0o755);
  });
});
