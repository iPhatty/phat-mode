import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { bashBlockReason, readBlockReason, readOnlyBashBlockReason, writeBlockReason } from '../src/guards.ts';

describe('bashBlockReason', () => {
  test('allows ordinary development commands', () => {
    for (const command of [
      'npm run check',
      'npm test -- --watch=false',
      'ls -la src',
      'grep -rn "HSK" src',
      'git status',
      'git diff origin/main',
      'git log --oneline -5',
      'git log --grep commit',
      'git diff -- src/reset.ts',
      'git -C . status',
      'git show HEAD:package.json',
      'npx expo install expo-haptics',
      'cat package.json',
      'rm -rf node_modules/.cache',
    ]) {
      assert.equal(bashBlockReason(command), undefined, command);
    }
  });

  test('blocks git commands that change history, branches or remotes', () => {
    for (const command of [
      'git push origin main',
      'git commit -m "x"',
      'git -C . push',
      'npm test && git push --force',
      'git reset --hard HEAD~1',
      'git checkout main',
      'git remote add evil https://example.com/x.git',
      'git config user.email x@y.z',
      'git branch -D main',
      'cd src && git -c core.pager=cat push',
      'git --git-dir=.git --work-tree . commit -am x',
      'echo $(git push)',
      '/usr/bin/git push',
      'git pull',
    ]) {
      assert.match(bashBlockReason(command) ?? '', /^Blocked:/, command);
    }
  });

  test('blocks the GitHub CLI', () => {
    for (const command of ['gh pr merge 1', 'echo hi; gh issue close 3', 'x=$(gh auth token)']) {
      assert.match(bashBlockReason(command) ?? '', /GitHub/, command);
    }
  });

  test('phat-mode home: workspaces allowed, everything else blocked, including a way out with ..', () => {
    const ws = '/Users/me/.phat-mode/workspaces/iPhatty__phatty-lingo';
    for (const command of [
      `cd ${ws}/issue-2 && git diff origin/main --stat`,
      `sips -Z 1200 ${ws}/base/.verify/evidence/x/03.png --out ${ws}/issue-2-scratch/b.png`,
      `ls '${ws}/issue-2'`,
      'cat ~/.phat-mode/workspaces/a/issue-1/README.md',
    ]) {
      assert.equal(bashBlockReason(command), undefined, command);
    }
    for (const command of [
      'cat ~/.phat-mode/auth.json',
      'sqlite3 ~/.phat-mode/state.sqlite',
      'ls ~/.phat-mode',
      'cat ~/.phat-mode/workspaces/../auth.json',
      `cat ${ws}/../../auth.json`,
      `cd ${ws}/issue-2 && cat ~/.phat-mode/auth.json`,
      'cp $HOME/.phat-mode/config.json /tmp',
    ]) {
      assert.match(bashBlockReason(command) ?? '', /credential folders/, command);
    }
  });

  test('blocks sudo, deleting home or root, and reading credentials', () => {
    for (const command of ['sudo rm x', 'rm -rf ~', 'rm -rf /', 'cat ~/.ssh/id_ed25519', 'cat ~/.phat-mode/auth.json', 'cat ~/.config/gh/hosts.yml']) {
      assert.match(bashBlockReason(command) ?? '', /^Blocked:/, command);
    }
  });
});

describe('writeBlockReason', () => {
  const workspace = '/tmp/ws/issue-1';

  test('allows files inside the workspace', () => {
    assert.equal(writeBlockReason('src/app/index.tsx', workspace), undefined);
    assert.equal(writeBlockReason('/tmp/ws/issue-1/README.md', workspace), undefined);
  });

  test('blocks files outside the workspace', () => {
    assert.match(writeBlockReason('../issue-2/x.ts', workspace) ?? '', /outside the workspace/);
    assert.match(writeBlockReason('/etc/hosts', workspace) ?? '', /outside the workspace/);
    assert.match(writeBlockReason('/tmp/ws/issue-10/x.ts', workspace) ?? '', /outside the workspace/);
  });

  test('blocks the .git directory', () => {
    assert.match(writeBlockReason('.git/config', workspace) ?? '', /\.git/);
    assert.match(writeBlockReason('.git', workspace) ?? '', /\.git/);
  });
});

describe('readOnlyBashBlockReason', () => {
  test('blocks changing permissions, so a read-only checkout stays read-only', () => {
    for (const command of ['chmod -R u+w .', 'cd src && chmod 644 a.ts', 'chown me x', '/bin/chmod u+w x', 'chflags nouchg x', 'xattr -c x']) {
      assert.match(readOnlyBashBlockReason(command) ?? '', /read-only/, command);
    }
  });

  test('allows reading and running commands', () => {
    for (const command of ['npm run check', 'grep -rn chmodSync src', 'cat README.md', 'ls -la']) {
      assert.equal(readOnlyBashBlockReason(command), undefined, command);
    }
  });
});

describe('readBlockReason', () => {
  test('blocks credential folders and phat-mode’s home outside its workspaces, however the path is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phat-guard-'));
    try {
      const home = join(dir, 'home');
      const ws = join(home, 'workspaces', 'a__b', 'shape-1');
      await mkdir(ws, { recursive: true });
      await mkdir(join(dir, 'fake', '.ssh'), { recursive: true });
      await writeFile(join(dir, 'fake', '.ssh', 'id_rsa'), 'key');
      await writeFile(join(home, 'auth.json'), '{}');
      await symlink(join(dir, 'fake', '.ssh', 'id_rsa'), join(ws, 'innocent.txt'));
      await symlink(join(home, 'auth.json'), join(ws, 'notes.md'));
      for (const path of [
        '~/.ssh/id_rsa',
        '/Users/x/.aws/credentials',
        '~/.config/gh/hosts.yml',
        '~/.pi/agent/auth.json',
        '~/.phat-mode/auth.json',
        '../../../auth.json',
        join(home, 'state.sqlite'),
        'innocent.txt',
        'notes.md',
      ]) {
        assert.match((await readBlockReason(path, ws, join(dir, 'unused'))) ?? '', /credential folders/, path);
      }
      for (const path of ['README.md', join(ws, 'src/a.ts'), '../issue-1-scratch/notes.md', '/etc/hosts']) {
        assert.equal(await readBlockReason(path, ws, join(dir, 'unused')), undefined, path);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
