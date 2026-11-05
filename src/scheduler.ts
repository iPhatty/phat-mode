/**
 * How one `phat-mode watch` shares its runs between its projects: up to `maxParallelRuns` at once, at most one per
 * project. A run is a build or a shaping; waiting for a pull request to be merged is not. See "Parallel runs" in the README.
 */

/** One project of a watch, as the scheduler sees it. */
export type ProjectQueue = {
  repo: string;
  /**
   * Look at the project. When it has work, start it and return a function that waits for it to end; otherwise
   * undefined. Only asked while the project has no run going and a slot is free.
   */
  next(): Promise<(() => Promise<unknown>) | undefined>;
};

export type WatchOptions = {
  /** The projects to look at, in the watch's list order. Called before every look. */
  projects(): Promise<readonly ProjectQueue[]>;
  /** Runs at once, across the projects. */
  maxParallelRuns: number;
  /** Wait until the next look: the watch interval, cut short when `wake` aborts (a run has ended). */
  sleep(wake: AbortSignal): Promise<void>;
  /** A run that failed, or a look that did (offline, GitHub down): only that project's slot is affected. */
  onError(repo: string, error: unknown): void;
  /** Stops the watch. Runs going are left to the caller. */
  signal?: AbortSignal;
};

/**
 * Keep the projects busy, until `signal` aborts. Each look walks the list from just after the project that last started
 * (wrapping round), asking each idle project for work while a slot is free, so a freed slot goes to the next project in
 * list order and none starves. A run that ends, however it ends, frees its slot and its project, and a new look starts
 * at once.
 */
export async function watchProjects(options: WatchOptions): Promise<void> {
  const { maxParallelRuns, signal } = options;
  const busy = new Set<string>();
  let lastStarted: string | undefined;
  let wake = new AbortController();

  while (!signal?.aborted) {
    const projects = await options.projects();
    const from = lastStarted === undefined ? 0 : projects.findIndex((project) => project.repo === lastStarted) + 1;
    const order = [...projects.slice(from), ...projects.slice(0, from)];
    for (const project of order) {
      if (signal?.aborted || busy.size >= maxParallelRuns) break;
      if (busy.has(project.repo)) continue;
      let run: (() => Promise<unknown>) | undefined;
      try {
        run = await project.next();
      } catch (error) {
        options.onError(project.repo, error);
        continue;
      }
      if (run === undefined) continue;
      busy.add(project.repo);
      lastStarted = project.repo;
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => options.onError(project.repo, error))
        .finally(() => {
          busy.delete(project.repo);
          wake.abort();
        });
    }
    if (signal?.aborted) break;
    // A run that ended during the look: look again at once.
    if (!wake.signal.aborted) {
      await options.sleep(signal === undefined ? wake.signal : AbortSignal.any([wake.signal, signal]));
    }
    wake = new AbortController();
  }
}
