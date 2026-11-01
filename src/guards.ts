import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_HOME } from './config.ts';
import { isProtectedSkillPath } from './verify.ts';

/**
 * Shell commands agents may not run. Git history, branches and remotes, and everything on GitHub, belong to the
 * pipeline: agents only change files.
 */
const BLOCKED_GIT = new Set([
  'push', 'commit', 'reset', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'cherry-pick', 'revert',
  'remote', 'worktree', 'config', 'tag', 'stash', 'clean', 'branch', 'update-ref', 'filter-branch', 'am',
  'apply', 'pull', 'fetch', 'clone', 'submodule', 'gc', 'prune', 'replace', 'notes', 'symbolic-ref',
]);

/** Global git options that take a separate value, e.g. `git -C dir push`. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The subcommands of every `git` invocation in a command line, e.g. `cd x && git -C . push` gives ["push"]. */
export function gitSubcommands(command: string): string[] {
  const found: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&\n()`]|\$\(/)) {
    const words = segment.trim().split(/\s+/);
    const start = words.findIndex((word) => /(^|\/)git$/.test(word.replace(/^['"]|['"]$/g, '')));
    if (start === -1) continue;
    for (let i = start + 1; i < words.length; i++) {
      const word = words[i]!;
      if (GIT_OPTIONS_WITH_VALUE.has(word)) {
        i++;
      } else if (!word.startsWith('-')) {
        found.push(word.replace(/^['"]|['"]$/g, ''));
        break;
      }
    }
  }
  return found;
}

const BLOCKED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|[\s;&|(`$])gh\s/, reason: 'GitHub is handled by phat-mode itself, not by agents' },
  { pattern: /\bsudo\b/, reason: 'sudo is not allowed' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$|\/\*?\s*$)/, reason: 'deleting outside the workspace is not allowed' },
  { pattern: /\b(security|keychain)\b.*\b(find|dump|export)/, reason: 'reading the keychain is not allowed' },
  { pattern: /\.(ssh|aws|config\/gh|pi\/agent)\b/, reason: 'reading credential folders is not allowed' },
];

/**
 * phat-mode's home holds credentials and state, but also the workspaces agents work in. Paths into
 * `.phat-mode/workspaces/` are allowed; anything else there is not, including a way out with `..`.
 */
function phatModeHomeBlocked(command: string): boolean {
  for (const match of command.matchAll(/\.phat-mode\b([^\s'"`;|&<>()]*)/g)) {
    const rest = match[1] ?? '';
    if (!rest.startsWith('/workspaces/') || /(^|\/)\.\.(\/|$)/.test(rest)) return true;
  }
  return false;
}

export function bashBlockReason(command: string): string | undefined {
  const git = gitSubcommands(command).find((subcommand) => BLOCKED_GIT.has(subcommand));
  if (git !== undefined) {
    return `Blocked: \`git ${git}\` changes history, branches or remotes; phat-mode does that itself, not agents.`;
  }
  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `Blocked: ${reason}.`;
  }
  if (phatModeHomeBlocked(command)) return 'Blocked: reading credential folders is not allowed.';
  return undefined;
}

/** Why a file write is not allowed, or undefined when `path` is inside `workspace` and outside `.git`. */
export function writeBlockReason(path: string, workspace: string): string | undefined {
  const target = resolve(workspace, path);
  const inside = relative(workspace, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return `Blocked: ${path} is outside the workspace ${workspace}.`;
  }
  if (inside === '.git' || inside.startsWith(`.git/`)) {
    return 'Blocked: the .git directory is managed by phat-mode.';
  }
  if (isProtectedSkillPath(inside)) {
    return `Blocked: ${inside} is part of the repo's verification skill, which only humans change (via /maintain-verification-skill). You may update its features/ files when you change behaviour on purpose.`;
  }
  return undefined;
}

/** Commands that change permissions: a read-only agent could use them to make its read-only checkout writable again. */
const PERMISSION_CHANGE = /(^|[\s;&|(`$/])(chmod|chown|chgrp|chflags|chattr|setfacl|xattr)(\s|$)/;

/** Why a read-only agent (shaping's) may not run a command, beyond what blocks every agent. */
export function readOnlyBashBlockReason(command: string): string | undefined {
  if (PERMISSION_CHANGE.test(command)) return 'Blocked: this checkout is read-only; changing permissions is not allowed.';
  return undefined;
}

/** Credential folders, by path: the same ones bash commands may not name. */
const CREDENTIAL_PATH = /(^|\/)\.(ssh|aws|pi\/agent)(\/|$)|(^|\/)\.config\/gh(\/|$)/;

/**
 * Why reading `path` is not allowed: a credential folder, or phat-mode's home (credentials and state) outside its
 * workspaces. Checked on the path as given (`~` expanded, relative to `workspace`) and on where it really leads, so a
 * symlink or `..` cannot get around it. phat-mode's home is the default one, and the one the workspace lives in
 * (`<home>/workspaces/<repo>/<dir>`).
 */
export async function readBlockReason(path: string, workspace: string | null, home = DEFAULT_HOME): Promise<string | undefined> {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  const target = resolve(workspace ?? process.cwd(), expanded);
  const real = await realpath(target).catch(() => target);
  const homes = [home, workspace?.match(/^(.*)\/workspaces\/[^/]+\/[^/]+\/?$/)?.[1]].filter((dir): dir is string => !!dir);
  for (const candidate of new Set([target, real])) {
    if (CREDENTIAL_PATH.test(candidate)) return 'Blocked: reading credential folders is not allowed.';
    for (const dir of homes) {
      for (const root of new Set([resolve(dir), await realpath(dir).catch(() => resolve(dir))])) {
        const inside = relative(root, candidate);
        const inHome = inside === '' || !(inside.startsWith('..') || isAbsolute(inside));
        const inWorkspaces = inside === 'workspaces' || inside.startsWith(`workspaces/`);
        if (inHome && !inWorkspaces) return 'Blocked: reading credential folders is not allowed.';
      }
    }
    if (phatModeHomeBlocked(candidate)) return 'Blocked: reading credential folders is not allowed.';
  }
  return undefined;
}
