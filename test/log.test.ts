import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { consoleLoggerFor } from '../src/log.ts';

test('every line of a project logger names the project, so parallel runs stay readable', () => {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  const log = mock.method(console, 'log', capture);
  const error = mock.method(console, 'error', capture);
  try {
    const logger = consoleLoggerFor('owner/lingo');
    logger.step(12, 'Plan');
    logger.info('Parent #3 closed');
    logger.error('#12 is not ready-for-agent');
    logger.tool('implement', '$ npm test');
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  assert.equal(lines.length, 4);
  for (const line of lines) assert.match(line, /\blingo\b/, line);
  assert.match(lines[0]!, /lingo#12/);
});

test('a tool line names its run (name#issue), whichever logger prints it', () => {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  try {
    consoleLoggerFor().tool('verify', '$ npm start', 'lingo#7');
  } finally {
    log.mock.restore();
  }
  assert.match(lines[0]!, /lingo#7\s+verify\s+\$ npm start/);
});
