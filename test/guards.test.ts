import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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

  test('a custom home not named .phat-mode is protected outside its workspaces', () => {
    const home = join(homedir(), 'pm2');
    const ws = join(home, 'workspaces', 'a', 'issue-1');
    for (const command of ['cat ~/pm2/auth.json', 'sqlite3 $HOME/pm2/state.sqlite', `cat ${home}/auth.json`, `ls ${home}`]) {
      assert.match(bashBlockReason(command, ws, home) ?? '', /credential folders/, command);
      assert.match(bashBlockReason(command, null, home) ?? '', /credential folders/, command);
    }
    assert.equal(bashBlockReason('cat ~/pm2/workspaces/a/issue-1/x', ws, home), undefined);
  });

  test('a home that only shares the .phat-mode prefix is not mistaken for the default home', () => {
    const home = join(homedir(), '.phat-mode-2');
    const ws = join(home, 'workspaces', 'a', 'issue-1');
    const allowed = `cd ${ws} && ls ${ws}-scratch`;
    assert.equal(bashBlockReason(allowed, ws, home), undefined);
    assert.equal(bashBlockReason(allowed), undefined);
    assert.match(bashBlockReason('cat ~/.phat-mode-2/auth.json', ws, home) ?? '', /credential folders/);
  });

  test('~, $HOME, ${HOME}, quoted and absolute forms of a path are judged alike', () => {
    const home = join(homedir(), 'pm2');
    for (const [rest, blocked] of [['pm2/auth.json', true], ['pm2/workspaces/a/issue-1/x', false]] as const) {
      for (const path of [`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`, `"$HOME"/${rest}`, `'${homedir()}/${rest}'`, `${homedir()}/${rest}`]) {
        const reason = bashBlockReason(`cat ${path}`, null, home);
        if (blocked) assert.match(reason ?? '', /credential folders/, path);
        else assert.equal(reason, undefined, path);
      }
    }
  });

  test('.. out of workspaces is blocked, for the default and a custom home', () => {
    const home = join(homedir(), 'pm2');
    for (const command of [
      'cat ~/pm2/workspaces/../auth.json',
      `sqlite3 ${home}/workspaces/a/../../state.sqlite`,
      `cat ${join(homedir(), '.phat-mode')}/workspaces/a/../../auth.json`,
      'cat ~/.phat-mode/workspaces/../auth.json',
    ]) {
      assert.match(bashBlockReason(command, null, home) ?? '', /credential folders/, command);
    }
  });

  test('the default home stays protected when a custom home is set', () => {
    const home = join(homedir(), 'pm2');
    for (const command of ['cat ~/.phat-mode/auth.json', `cat ${join(homedir(), '.phat-mode', 'state.sqlite')}`]) {
      assert.match(bashBlockReason(command, join(home, 'workspaces', 'a', 'issue-1'), home) ?? '', /credential folders/, command);
    }
  });

  test('relative paths are judged from every folder the command might be in: where it runs, or where a cd took it', () => {
    for (const home of [join(homedir(), 'pm2'), join(homedir(), '.phat-mode')]) {
      const ws = join(home, 'workspaces', 'a', 'issue-1');
      for (const command of [
        'cat ../../../auth.json',
        'sqlite3 ../../../state.sqlite',
        'cd ../.. && cat ../auth.json',
        `cd ${home} && cat auth.json`,
        'cd ~/.phat-mode; ls',
        'cd .. && cd .. && cd .. && ls',
        '(cd src && ls); cat ../../../auth.json',
        'cd src | cat ../../../auth.json',
        '(cd a); cd b; cat ../../../../auth.json',
        `(cd ${ws}-scratch); cat ../../../state.sqlite`,
        'cd missing; cat ../../../auth.json',
        'cd missing || cat ../../../auth.json',
        'cd src & cat ../../../auth.json',
        'echo "$(cd src)" && cat ../../../auth.json',
      ]) {
        assert.match(bashBlockReason(command, ws, home) ?? '', /credential folders/, `${home}: ${command}`);
      }
      for (const command of [
        'cat ../issue-1-scratch/notes.md',
        'cd src && cat ../README.md',
        'ls -la',
        `cd ${ws}-scratch && ls ../issue-1`,
        'cd src/deep/x && cat ../../../README.md',
        ['web', 'api', 'docs', 'cli'].map((dir) => `cd ${dir} && npm test && cd ..`).join(' && '),
        '(cd web && npm run build) && npm test',
      ]) {
        assert.equal(bashBlockReason(command, ws, home), undefined, `${home}: ${command}`);
      }
      const lost = Array.from({ length: 8 }, (_, i) => `cd d${i}`).join('; ');
      assert.match(bashBlockReason(lost, ws, home) ?? '', /too many ways/, `${home}: ${lost}`);
    }
  });

  test('quoted and escaped paths keep their spaces, so a home with spaces is protected', () => {
    const home = join(homedir(), 'pm home');
    const ws = join(home, 'workspaces', 'a', 'issue-1');
    for (const command of [
      `cat "${home}/auth.json"`,
      `cat '${home}/state.sqlite'`,
      `cat ${home.replace(' ', '\\ ')}/auth.json`,
      'cat ~/"pm home"/auth.json',
      'cat "$HOME/pm home/auth.json"',
      `cd "${ws}" && cat ../../../auth.json`,
    ]) {
      assert.match(bashBlockReason(command, ws, home) ?? '', /credential folders/, command);
    }
    for (const command of [`cat "${ws}/README.md"`, `ls '${ws}-scratch'`, `cd "${ws}" && cat src/a.ts`]) {
      assert.equal(bashBlockReason(command, ws, home), undefined, command);
    }
  });

  test('commands inside a command substitution are judged too, also inside double quotes', () => {
    for (const home of [join(homedir(), 'pm2'), join(homedir(), '.phat-mode')]) {
      const ws = join(home, 'workspaces', 'a', 'issue-1');
      for (const command of [
        `echo "$(cat ${home}/auth.json)"`,
        `echo "x $(sqlite3 ${home}/state.sqlite .dump) y"`,
        `echo "$(cat "${home}/auth.json")"`,
        `echo "$(echo "$(cat ${home}/auth.json)")"`,
        `echo "\`cat ${home}/auth.json\`"`,
        `echo $(cat ${home}/auth.json)`,
        'echo "$(cat ../../../auth.json)"',
      ]) {
        assert.match(bashBlockReason(command, ws, home) ?? '', /credential folders/, `${home}: ${command}`);
      }
      for (const command of [
        `echo "$(cat ${ws}/README.md)"`,
        'echo "$(ls src) and $((1 + 2))"',
        `echo "\`ls ${ws}\`" "(${ws})"`,
        `cat "$(git rev-parse --show-toplevel)/README.md"`,
      ]) {
        assert.equal(bashBlockReason(command, ws, home), undefined, `${home}: ${command}`);
      }
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

describe('bash and the read tool judge phat-mode’s home alike', () => {
  const cases: { name: string; home: string; paths: [string, boolean][] }[] = [
    {
      name: 'a custom home',
      home: join(homedir(), 'pm2'),
      paths: [
        ['~/pm2/auth.json', true],
        [join(homedir(), 'pm2', 'state.sqlite'), true],
        [join(homedir(), 'pm2', 'workspaces', 'a', '..', '..', 'auth.json'), true],
        ['~/pm2/workspaces/a/issue-1/README.md', false],
        ['../../../auth.json', true],
        ['../issue-1-scratch/x', false],
        ['~/.phat-mode/auth.json', true],
        ['/etc/hosts', false],
      ],
    },
    {
      name: 'a home named .phat-mode-2',
      home: join(homedir(), '.phat-mode-2'),
      paths: [
        ['~/.phat-mode-2/auth.json', true],
        [join(homedir(), '.phat-mode-2', 'workspaces', 'a', 'issue-1-scratch', 'x'), false],
        ['~/.phat-mode/config.json', true],
      ],
    },
    {
      name: 'the default home',
      home: join(homedir(), '.phat-mode'),
      paths: [
        ['~/.phat-mode/auth.json', true],
        ['~/.phat-mode/workspaces/../state.sqlite', true],
        ['../../../state.sqlite', true],
        [join(homedir(), '.phat-mode', 'workspaces', 'a', 'issue-1', 'x'), false],
        [join(homedir(), '.phat-mode-2', 'workspaces', 'a', 'issue-1', 'x'), false],
      ],
    },
    {
      name: 'a home with a space in its name',
      home: join(homedir(), 'pm home'),
      paths: [
        [`"${join(homedir(), 'pm home', 'auth.json')}"`, true],
        [`"${join(homedir(), 'pm home', 'workspaces', 'a', 'issue-1', 'x')}"`, false],
      ],
    },
  ];
  for (const { name, home, paths } of cases) {
    test(name, async () => {
      const ws = join(home, 'workspaces', 'a', 'issue-1');
      for (const [path, blocked] of paths) {
        const bash = bashBlockReason(`cat ${path}`, ws, home) !== undefined;
        const read = (await readBlockReason(path.replace(/^"|"$/g, ''), ws, home)) !== undefined;
        assert.equal(bash, blocked, `bash: ${path}`);
        assert.equal(read, blocked, `read: ${path}`);
      }
    });
  }
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
