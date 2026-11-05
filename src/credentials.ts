import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLock, LockedError } from './lock.ts';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type CredentialFile = Record<string, Credential>;

/** How often a write waiting for another process's write looks again. */
const RETRY_MS = 20;

/**
 * Credentials in a JSON file (mode 0600), shared by every phat-mode process. Writes are serialized in-process and, with
 * a file lock (`<file>.lock`), across processes; each re-reads the file once it holds the lock. pi-ai's token refresh
 * relies on that: inside `modify` it sees the newest token, so it never refreshes again, or overwrites a newer token
 * with an older one.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async #save(data: CredentialFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.#path);
  }

  /** Run `work` alone: after this store's earlier writes, and holding the file lock against other processes. */
  #serialize<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.#chain.catch(() => {}).then(async () => {
      const lock = await this.#lock(signal);
      try {
        return await work();
      } finally {
        await lock.release();
      }
    });
    this.#chain = next;
    return next;
  }

  async #lock(signal?: AbortSignal) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await acquireLock(`${this.#path}.lock`, 'phat-mode (credentials)');
      } catch (error) {
        if (!(error instanceof LockedError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.#load())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.#load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serialize(async () => {
      // Read under the lock: another process may have written a newer token.
      const data = await this.#load();
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      await this.#save(data);
      return next;
    }, options?.signal);
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(async () => {
      const data = await this.#load();
      delete data[providerId];
      await this.#save(data);
    });
  }
}

export const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');

/** Copy one provider's login from the pi coding agent's auth.json. Returns false when it has none. */
export async function importPiCredential(
  store: CredentialStore,
  providerId: string,
  piAuthPath = PI_AUTH_PATH,
): Promise<boolean> {
  let data: CredentialFile;
  try {
    data = JSON.parse(await readFile(piAuthPath, 'utf8')) as CredentialFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const credential = data[providerId];
  if (credential === undefined) return false;
  await store.modify(providerId, async () => credential);
  return true;
}
