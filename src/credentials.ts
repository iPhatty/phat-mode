import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type CredentialFile = Record<string, Credential>;

/**
 * Credentials in a JSON file (mode 0600). One phat-mode process owns the file at a time; writes are serialized
 * in-process, which is what pi-ai's token refresh relies on.
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
    const temp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.#path);
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.catch(() => {}).then(work);
    this.#chain = next;
    return next;
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
      options?.signal?.throwIfAborted();
      const data = await this.#load();
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      await this.#save(data);
      return next;
    });
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
