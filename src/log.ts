const time = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

export type Logger = {
  info(message: string): void;
  step(issue: number, message: string): void;
  /** An agent's tool call. `run`: the run it belongs to (`name#12`), when known. */
  tool(label: string, message: string, run?: string): void;
  error(message: string): void;
};

/** The short name of a run, as log lines show it: `name#12` (`#12` without a repo, '' without an issue either). */
export function runName(repo: string | null | undefined, issue: number | null | undefined): string {
  const name = repo == null ? '' : repo.slice(repo.indexOf('/') + 1);
  return issue == null ? name : `${name}#${issue}`;
}

/**
 * Logs to the console. `repo`: every line names the project (steps show `name#12` instead of `#12`), for when several
 * repos, or parallel runs, share the log.
 */
export function consoleLoggerFor(repo?: string): Logger {
  const prefix = runName(repo, undefined);
  const named = (message: string) => (prefix === '' ? message : `${prefix}: ${message}`);
  return {
    info: (message) => console.log(`${time()}  ${named(message)}`),
    step: (issue, message) => console.log(`${time()}  ${prefix}#${issue}  ▸ ${message}`),
    tool: (label, message, run = prefix) => console.log(`${time()}      ${run === '' ? '' : `${run}  `}${label.padEnd(9)} ${message}`),
    error: (message) => console.error(`${time()}  ✖ ${named(message)}`),
  };
}

export const consoleLogger: Logger = consoleLoggerFor();

export const silentLogger: Logger = {
  info: () => {},
  step: () => {},
  tool: () => {},
  error: () => {},
};

/** One line, at most `max` characters. */
export function oneLine(text: string, max = 100): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
