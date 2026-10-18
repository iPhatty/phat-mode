import { isAbsolute, relative, resolve } from 'node:path';
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
  { pattern: /\.(ssh|aws|config\/gh|phat-mode|pi\/agent)\b/, reason: 'reading credential folders is not allowed' },
];

export function bashBlockReason(command: string): string | undefined {
  const git = gitSubcommands(command).find((subcommand) => BLOCKED_GIT.has(subcommand));
  if (git !== undefined) {
    return `Blocked: \`git ${git}\` changes history, branches or remotes; phat-mode does that itself, not agents.`;
  }
  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `Blocked: ${reason}.`;
  }
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
