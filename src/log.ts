const time = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

export type Logger = {
  info(message: string): void;
  step(issue: number, message: string): void;
  tool(label: string, message: string): void;
  error(message: string): void;
};

export const consoleLogger: Logger = {
  info: (message) => console.log(`${time()}  ${message}`),
  step: (issue, message) => console.log(`${time()}  #${issue}  ▸ ${message}`),
  tool: (label, message) => console.log(`${time()}      ${label.padEnd(9)} ${message}`),
  error: (message) => console.error(`${time()}  ✖ ${message}`),
};

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
