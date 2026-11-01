import { access, cp, lstat, mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoSettings } from './config.ts';
import { PROJECT_SKILLS, skillDir, VERIFICATION_SKILLS } from './skills.ts';
import { findVerifySkills, SKILL_ROOTS } from './verify.ts';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Commands phat-mode can suggest for a repo, and how it found them. Either may be missing. */
export type Detected = { installCommand?: string; checkCommand?: string; notes: string[] };

/** Scripts that make up a project's checks, in the order they should run. */
const CHECK_SCRIPTS = ['lint', 'typecheck', 'type-check', 'test'];

/**
 * Suggest the install and check commands from the repo's files. Only a suggestion: `phat-mode init` asks before writing
 * them, because the check command is what stops a broken change from becoming a pull request.
 */
export async function detectCommands(root: string): Promise<Detected> {
  const notes: string[] = [];
  const has = (file: string) => exists(join(root, file));

  if (await has('package.json')) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    let pm: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm';
    let installCommand = 'npm install';
    if (await has('pnpm-lock.yaml')) [pm, installCommand] = ['pnpm', 'pnpm install --frozen-lockfile'];
    else if (await has('yarn.lock'))
      [pm, installCommand] = ['yarn', (await has('.yarnrc.yml')) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'];
    else if ((await has('bun.lock')) || (await has('bun.lockb'))) [pm, installCommand] = ['bun', 'bun install --frozen-lockfile'];
    else if (await has('package-lock.json')) installCommand = 'npm ci';
    else notes.push('No lockfile: installs are not reproducible. Commit one.');
    notes.push(`package.json, ${pm}`);

    const script = (name: string) => (name === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${name}`);
    let checkCommand: string | undefined;
    if (scripts.check !== undefined) checkCommand = script('check');
    else {
      const parts = CHECK_SCRIPTS.filter((name) => scripts[name] !== undefined);
      // npm's placeholder test script always fails.
      const usable = parts.filter((name) => !(name === 'test' && /no test specified/.test(scripts.test ?? '')));
      if (usable.length > 0) {
        checkCommand = usable.map(script).join(' && ');
        notes.push(`No "check" script: combined ${usable.join(', ')}`);
      }
    }
    return { installCommand, ...(checkCommand === undefined ? {} : { checkCommand }), notes };
  }
  if (await has('Cargo.toml')) {
    return { installCommand: 'cargo fetch', checkCommand: 'cargo clippy --all-targets -- -D warnings && cargo test', notes: ['Cargo.toml'] };
  }
  if (await has('go.mod')) {
    return { installCommand: 'go mod download', checkCommand: 'go vet ./... && go test ./...', notes: ['go.mod'] };
  }
  if (await has('Makefile')) {
    const makefile = await readFile(join(root, 'Makefile'), 'utf8');
    if (/^check:/m.test(makefile)) return { installCommand: 'true', checkCommand: 'make check', notes: ['Makefile with a check target'] };
  }
  return { notes: ['No package.json, Cargo.toml, go.mod or Makefile check target found'] };
}

/** The settings file `phat-mode init` writes: only what the repo decided, nothing that has a default. */
export const settingsFile = (settings: RepoSettings) => `${JSON.stringify(settings, null, 2)}\n`;

/** Files that tell agents (and the Standards reviewer) the repo's rules. */
const STANDARDS_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.github/copilot-instructions.md'];

export type Readiness = {
  standards: string[];
  verifySkills: string[];
  /** mattpocock/skills' label mapping, if the repo has one. */
  triageLabels: string | undefined;
};

export type InstalledSkills = {
  /** Copied into `.agents/skills/`. */
  installed: string[];
  /** Already in the repo (any skills folder): left as they are, the repo owns them. */
  kept: string[];
  /** `.claude/skills/<name>` links made to the `.agents/skills/` copy, for Claude Code. */
  linked: string[];
};

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Whether the checkout has a `verify-*` skill in any skills folder, committed or not. */
async function hasVerifySkill(root: string): Promise<boolean> {
  for (const dir of SKILL_ROOTS) {
    const names = await readdir(join(root, dir)).catch(() => [] as string[]);
    for (const name of names) if (name.startsWith('verify-') && (await exists(join(root, dir, name, 'SKILL.md')))) return true;
  }
  return false;
}

/**
 * Copy phat-mode's pinned `PROJECT_SKILLS` and `VERIFICATION_SKILLS` into the repo's `.agents/skills/`, the folder most
 * agents read; `create-verification-skill` only while the repo has no verify skill. Never replaces a skill the repo
 * already has, in any skills folder: once there, the repo owns it. Claude Code reads only `.claude/skills/`, so a repo
 * that uses it (a `.claude/` folder or `CLAUDE.md`) also gets a link there.
 */
export async function installProjectSkills(root: string): Promise<InstalledSkills> {
  const result: InstalledSkills = { installed: [], kept: [], linked: [] };
  const claude = (await present(join(root, '.claude'))) || (await present(join(root, 'CLAUDE.md')));
  const verification = (await hasVerifySkill(root))
    ? VERIFICATION_SKILLS.filter((skill) => skill !== 'create-verification-skill')
    : VERIFICATION_SKILLS;
  for (const skill of [...PROJECT_SKILLS, ...verification]) {
    const existing = [];
    for (const dir of SKILL_ROOTS) if (await present(join(root, dir, skill))) existing.push(dir);
    if (existing.length > 0) {
      result.kept.push(`${existing[0]}/${skill}`);
      continue;
    }
    const target = join(root, '.agents/skills', skill);
    await cp(fileURLToPath(skillDir(skill)), target, { recursive: true });
    result.installed.push(`.agents/skills/${skill}`);
    if (claude) {
      const link = join(root, '.claude/skills', skill);
      await mkdir(join(root, '.claude/skills'), { recursive: true });
      await symlink(relative(join(root, '.claude/skills'), target), link, 'dir');
      result.linked.push(`.claude/skills/${skill}`);
    }
  }
  return result;
}

/** What the repo has that phat-mode uses. Read from `HEAD`, as runs read from the base branch. */
export async function readiness(root: string): Promise<Readiness> {
  const standards: string[] = [];
  for (const file of STANDARDS_FILES) if (await exists(join(root, file))) standards.push(file);
  const verifySkills = (await findVerifySkills(root, 'HEAD').catch(() => [])).map((skill) => skill.dir);
  const triage = join(root, 'docs/agents/triage-labels.md');
  return { standards, verifySkills, triageLabels: (await exists(triage)) ? 'docs/agents/triage-labels.md' : undefined };
}
