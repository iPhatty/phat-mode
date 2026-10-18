import { spawn } from 'node:child_process';

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Resolve with a nonzero exit code instead of throwing. */
  allowFailure?: boolean;
};

export class CommandError extends Error {
  readonly result: RunResult;
  constructor(command: string, result: RunResult) {
    super(`${command} exited with ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
    this.result = result;
  }
}

/** Run a program without a shell. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, options.timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\n[timed out after ${options.timeoutMs} ms]` : stderr,
      };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new CommandError([command, ...args].join(' '), result));
      } else {
        resolve(result);
      }
    });
    child.stdin.end(options.input ?? '');
  });
}

/** Run a command line through `sh -c`, for user-configured commands such as `npm run check`. */
export function runShell(commandLine: string, options: RunOptions = {}): Promise<RunResult> {
  return run('/bin/sh', ['-c', commandLine], options);
}

/**
 * The environment agent commands run with: the user's environment minus credentials, so a prompt-injected command
 * cannot read tokens from it.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const secret = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|CREDENTIAL|AUTH)/i;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !secret.test(name)));
}
