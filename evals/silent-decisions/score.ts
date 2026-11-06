/**
 * Step 5 of the silent-decisions eval kit: every `<dir>/*\/judgement.json` aggregated into a Markdown report.
 * Deterministic. See README.md. Not part of phat-mode's runtime.
 *
 *   node evals/silent-decisions/score.ts runs/2026-12-01 --out evals/silent-decisions/results/2026-12-01.md
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate, parseJudgement, report } from './judgement.ts';

async function main() {
  const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
  const dir = positionals[0];
  if (dir === undefined) throw new Error('Usage: score.ts <dir with one folder per ticket> [--out report.md]');
  const folders = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const judgements = [];
  for (const folder of folders) {
    const path = join(dir, folder, 'judgement.json');
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text === undefined) {
      console.error(`No judgement in ${join(dir, folder)}: left out`);
      continue;
    }
    judgements.push(parseJudgement(text, path));
  }
  const markdown = report(aggregate(judgements));
  if (values.out === undefined) process.stdout.write(markdown);
  else {
    await writeFile(values.out, markdown);
    console.error(`Wrote ${values.out} (${judgements.length} ticket(s))`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
