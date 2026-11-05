import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_HOME, STANDARD_HOME } from './config.ts';
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
 * The phat-mode homes an agent may not look into outside `workspaces/`: the configured home, the standard
 * `~/.phat-mode`, and the home the workspace lives in (`<home>/workspaces/<repo>/<dir>`). Each one also as its real
 * path, so a symlinked home is recognised either way.
 */
export function phatModeHomes(home: string = DEFAULT_HOME, workspace: string | null = null): string[] {
  const fromWorkspace = workspace?.match(/^(.*)\/workspaces\/[^/]+\/[^/]+\/?$/)?.[1];
  const homes = new Set<string>();
  for (const dir of [home, STANDARD_HOME, fromWorkspace]) {
    if (!dir) continue;
    const root = resolve(dir);
    homes.add(root);
    try {
      homes.add(realpathSync(root));
    } catch {
      // A home that does not exist yet has no other real path.
    }
  }
  return [...homes];
}

/**
 * The one rule both guards share: phat-mode's home holds credentials and state, but also the workspaces agents work
 * in. A path into `<home>/workspaces/` is allowed; the home itself and anything else in it is not. `path` must have
 * its `..` already resolved. A folder that only shares a home's name as a prefix (`.phat-mode-2`) is not inside it.
 * Any folder named exactly `.phat-mode` also counts as a home, so another user's or a relative one is protected too.
 */
export function inHomeOutsideWorkspaces(path: string, homes: string[]): boolean {
  const outsideWorkspaces = (rest: string) => !(rest === 'workspaces' || rest.startsWith('workspaces/'));
  if (isAbsolute(path)) {
    for (const root of homes) {
      const inside = relative(root, path);
      const inHome = inside === '' || !(inside === '..' || inside.startsWith('../') || isAbsolute(inside));
      if (inHome && outsideWorkspaces(inside)) return true;
    }
  }
  const segments = path.split('/');
  const at = segments.indexOf('.phat-mode');
  return at !== -1 && outsideWorkspaces(segments.slice(at + 1).filter((segment) => segment !== '').join('/'));
}

/** A shell word, with quotes and escapes resolved, and the parts it has after an unquoted `=` or `:` (`--out=/x`). */
type ShellWord = { text: string; parts: string[] };

/** Characters that end a word, outside quotes. `null` stands for the end of a command, where a new one starts. */
const OPERATORS = new Set([';', '|', '&', '<', '>', '(', ')', '`', '\n']);

/**
 * The words of a shell command as the shell would read them: quotes and backslash escapes resolved (so a path with
 * spaces stays one word), `~` at the start of a word and `$HOME` / `${HOME}` outside single quotes expanded. `null`
 * marks where one command ends and the next begins (`;`, `&&`, `|`, `(`, `$(`…). A command substitution (`$(…)`, or
 * `` `…` `` inside double quotes) is read as commands of its own, also inside double quotes, as the shell runs it.
 */
function shellWords(command: string): (ShellWord | null)[] {
  const home = homedir();
  const out: (ShellWord | null)[] = [];
  let text = '';
  let part = '';
  let parts: string[] = [];
  let started = false;
  let quote: "'" | '"' | null = null;
  /** Open command substitutions, innermost last: the quote to go back to, and the `(` still open inside it. */
  const substitutions: { quote: '"' | null; depth: number; backtick: boolean }[] = [];
  const add = (chars: string) => {
    text += chars;
    part += chars;
    started = true;
  };
  const endWord = () => {
    if (started) out.push({ text, parts: [...parts, part] });
    text = '';
    part = '';
    parts = [];
    started = false;
  };
  const openSubstitution = (backtick: boolean) => {
    endWord();
    if (out.at(-1) !== null) out.push(null);
    substitutions.push({ quote: quote as '"' | null, depth: 0, backtick });
    quote = null;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else add(char);
      continue;
    }
    if (char === '\\') {
      if (next === undefined) continue;
      if (quote === '"' && !'$`"\\\n'.includes(next)) add(char);
      else if (next !== '\n') add(next);
      i++;
      continue;
    }
    if (char === '$') {
      const variable = command.slice(i).match(/^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/)?.[0];
      if (variable) {
        add(home);
        i += variable.length - 1;
        continue;
      }
      if (next === '(') {
        openSubstitution(false);
        i++;
        continue;
      }
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '`') openSubstitution(true);
      else add(char);
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char) && char !== '\n') {
      endWord();
    } else if (OPERATORS.has(char)) {
      endWord();
      if (out.at(-1) !== null) out.push(null);
      const open = substitutions.at(-1);
      if (open !== undefined && open.backtick === (char === '`')) {
        if (char === '(') open.depth++;
        else if (char === ')' && open.depth > 0) open.depth--;
        else if (char === ')' || char === '`') quote = substitutions.pop()!.quote;
      }
    } else if (char === '~' && part === '' && (next === undefined || next === '/' || /[\s=:]/.test(next) || OPERATORS.has(next))) {
      add(home);
    } else if (char === '=' || char === ':') {
      text += char;
      parts.push(part);
      part = '';
      started = true;
    } else {
      add(char);
    }
  }
  endWord();
  return out;
}

/**
 * The paths a shell command names, as absolute paths with `..` resolved. Relative ones are resolved against where they
 * are used: `cwd` at first, then wherever a `cd` (or `pushd`) in the command moves to. Every word counts, and also each
 * part after an unquoted `=` or `:`, since a word that is not a path judges as a harmless file in the current folder.
 */
export function commandPaths(command: string, cwd: string): string[] {
  const paths: string[] = [];
  let here = resolve(cwd);
  let commandStart = true;
  let changingDirectory = false;
  const commandEnds = () => {
    if (changingDirectory) here = resolve(homedir()); // a bare `cd` goes home
    commandStart = true;
    changingDirectory = false;
  };
  for (const word of shellWords(command)) {
    if (word === null) {
      commandEnds();
      continue;
    }
    for (const text of new Set([word.text, ...word.parts])) {
      if (text !== '') paths.push(resolve(here, text));
    }
    if (changingDirectory && word.text === '-') {
      changingDirectory = false; // back to a folder this command line cannot know: stay
    } else if (changingDirectory && !word.text.startsWith('-')) {
      here = resolve(here, word.text);
      changingDirectory = false;
    } else if (commandStart) {
      changingDirectory = word.text === 'cd' || word.text === 'pushd';
    }
    commandStart = false;
  }
  commandEnds();
  return paths;
}

export function bashBlockReason(command: string, workspace: string | null = null, home: string = DEFAULT_HOME): string | undefined {
  const git = gitSubcommands(command).find((subcommand) => BLOCKED_GIT.has(subcommand));
  if (git !== undefined) {
    return `Blocked: \`git ${git}\` changes history, branches or remotes; phat-mode does that itself, not agents.`;
  }
  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `Blocked: ${reason}.`;
  }
  const homes = phatModeHomes(home, workspace);
  if (commandPaths(command, workspace ?? process.cwd()).some((path) => inHomeOutsideWorkspaces(path, homes))) {
    return 'Blocked: reading credential folders is not allowed.';
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
 * symlink or `..` cannot get around it. Same rule as bash: see {@link phatModeHomes} and {@link inHomeOutsideWorkspaces}.
 */
export async function readBlockReason(path: string, workspace: string | null, home = DEFAULT_HOME): Promise<string | undefined> {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  const target = resolve(workspace ?? process.cwd(), expanded);
  const real = await realpath(target).catch(() => target);
  const homes = phatModeHomes(home, workspace);
  for (const candidate of new Set([target, real])) {
    if (CREDENTIAL_PATH.test(candidate)) return 'Blocked: reading credential folders is not allowed.';
    if (inHomeOutsideWorkspaces(candidate, homes)) return 'Blocked: reading credential folders is not allowed.';
  }
  return undefined;
}
