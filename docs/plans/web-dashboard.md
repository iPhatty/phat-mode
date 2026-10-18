# Plan: status reporting and local web dashboard

Status: **not started** · Created 2026-10-18

Show what phat-mode is doing while it runs: a status comment on the GitHub issue, and a local web dashboard. A
terminal `watch` view is out of scope; the dashboard replaces it.

## How to use this file

- Work through it top to bottom. Each phase can ship on its own and leaves `npm run check` green.
- Tick a box (`- [x]`) when it is done, merged into `main`, and covered by tests where the item says so.
- At the end of each session, add a line to the [Session log](#session-log): what was done, what is next, and any
  decision made. Record lasting decisions under [Decisions](#decisions) too.
- If the plan changes, edit it here rather than working around it, and say why in the log.

## Background

- `openPhatMode()` takes a lock on `~/.phat-mode/state.sqlite.lock`: one process at a time. While `run` works, `status`,
  `abort`, or a dashboard in another process exit with "already running". **The dashboard must therefore live inside
  the process that runs the work**: a long-running `phat-mode serve` daemon. The CLI commands become clients of it.
- State the dashboard needs is already stored:
  - `RunsDoc` (root conversation): every run per issue, `taskId` and `startedAt`.
  - Pipeline task checkpoint: `phase`, `issue`, `spec`, `plan`, `runs`, `checkFixes`, `reviewRounds`, `verifyRounds`,
    `review`, `unresolved`, `verification`, `pr`, and the `fail` reason.
  - `conversations`: one conversation per agent (`plan`, `implement`, `standards`, `spec`, `verify`), each tagged
    by `RoleDoc` and owned by the pipeline task.
  - Per conversation: `pi.live` (streaming answer, running tools), `pi.usage` (tokens and cost), and the transcript.
- Pi Durable gives live views: `harness.watchTaskGraph()`, `conversation.viewState()` / `watch()`, `watchEvents()`.
  A client that connects mid-run gets the current state first, then changes (durable example 21).
- `github.upsertComment(issue, marker, body)` already updates a marked comment in place (`MARKERS.plan`,
  `MARKERS.result` in `pipeline.ts`).

## Phase 1: Status comment on the issue

One comment per issue, updated in place at each phase change. Works without the daemon.

- [ ] Add `MARKERS.status` and a pure `statusComment(state, run)` renderer in `src/messages.ts`
  - [ ] Phase stepper: Prepare, Plan, Implement, Checks, Review, Verify, Describe, Publish (done / current / pending)
  - [ ] Budgets: check fixes `n/maxCheckFixes`, review round `n/maxReviewRounds`, verify round `n/maxVerifyRounds`,
        implementer runs
  - [ ] Run number, start time, workspace branch, and "resumed after restart" when it was
  - [ ] Cost so far (sum of `pi.usage` over the run's conversations)
  - [ ] Plan in a collapsed `<details>` once it exists
- [ ] Update it from the pipeline at each phase change (one helper next to `go()`); failures to post never fail the run
- [ ] Final state: collapse to a link to the PR, the hand-back reason, or the failure reason
- [ ] Decide whether `MARKERS.plan` / `MARKERS.result` merge into it or stay separate (record under Decisions)
- [ ] Tests: renderer unit tests; pipeline test asserts one comment is updated, never duplicated, across a restart

## Phase 2: `phat-mode serve` daemon

One process owns the database, runs the work, and serves clients.

- [ ] `phat-mode serve`: started by hand only, runs in the foreground. Opens phat-mode once, holds the lock,
      `harness.resume()`, keeps running until Ctrl-C (progress saved, as today). No `launchd`, no auto-start.
- [ ] On start, print the dashboard URL (with a one-time login token) and offer to open it
- [ ] Local API on `127.0.0.1` only (port in config, default e.g. `4317`). Every route names the repo, so more repos
      can be added later without changing the API (see Decisions); `:repo` is `owner/name`, URL-encoded
  - [ ] `GET /api/runs`: list of runs with repo, issue, title, phase, status, budgets, cost, started/updated times
  - [ ] `GET /api/runs/:repo/:issue`: one run in full (checkpoint, history of earlier runs from `RunsDoc`)
  - [ ] `POST /api/runs` `{ repo, issue }`: start or resume (same as `phat.start()`); rejects repos not in config
  - [ ] `POST /api/runs/:repo/:issue/abort`
  - [ ] `GET /api/events`: Server-Sent Events from `watchTaskGraph()` and run changes
  - [ ] `GET /api/runs/:repo/:issue/agents/:role/events`: SSE of that conversation's `watchEvents()`, snapshot first
  - [ ] `GET /api/usage`: cost per run, per role, per model, and totals for today
- [ ] Shared API types in one module (`src/api-types.ts`) that the TanStack Start app imports, so both sides stay in step
- [ ] Security: bind to loopback only, random token in `~/.phat-mode/serve.json` (owner-only). The CLI sends it as
      a header; the browser exchanges the one-time URL token for an `HttpOnly`, `SameSite=Strict` cookie. Check
      `Origin`/`Host` on every request (no CSRF, no DNS rebinding)
- [ ] CLI as clients: `run`, `status`, `abort`, `resume` use the daemon when `serve.json` points to a live one, and
      keep today's direct behaviour when it does not
- [ ] Logging: `consoleLogger` output also kept in a ring buffer per run for the dashboard
- [ ] Tests: API with the fake model and fake GitHub from `pipeline.test.ts`; token required; CLI falls back when no
      daemon is running; every route takes the repo

## Phase 3: Pick up issues automatically (optional, still in the daemon)

> **Done early, without the daemon (2026-10-18):** `phat-mode watch` (`src/watch.ts`) works through ready issues one
> at a time, starting the next one when a phat-mode PR merges. It works everything out from GitHub on each look instead
> of a durable polling task, since GitHub already holds the state. When the daemon lands, `watch` moves into it.

- [ ] Poll GitHub every N minutes (config `poll.intervalMs`, off by default) for open `ready-for-agent` issues
- [ ] Start at most `poll.concurrency` runs at a time (default 1); skip issues with a live or finished run unless they
      were relabelled
- [ ] Polling state is durable (a sleeping task with `sleepUntil`), so a sleeping laptop catches up on wake
- [ ] Tests: eligible issue starts once; ineligible ones are left alone; concurrency limit holds

## Phase 4: Web dashboard (read only)

Served by the daemon at `http://127.0.0.1:<port>/`. First version only shows things; no controls.

- [ ] Set up the TanStack Start app (React, TypeScript, Vite) in `web/`, with its own `package.json` so the CLI's
      dependencies stay small
  - [ ] **SPA mode** (`spa: { enabled: true }` in the Start Vite plugin): the build writes static client files plus
        a prerendered shell (`_shell.html`). `phat-mode serve` serves `web/dist/client` from the same origin as the
        API and sends any other non-`/api` path to the shell. One process, one port, no Start server at runtime
        (see Decisions)
  - [ ] No server functions or server routes: the daemon's `/api/*` is the only backend
  - [ ] Data in the browser with TanStack Query against `/api/*`; SSE (`EventSource`) updates the query cache
  - [ ] File-based routes with TanStack Router: `/` (runs) and `/runs/$owner/$repo/$issue` (run page), typed params;
        filters (repo, status) as typed search params
  - [ ] Dev loop: `vite dev` with `server.proxy` sending `/api/*` to a running `phat-mode serve`
  - [ ] Root scripts: `npm run web:build`, `npm run web:dev`; `npm run check` also type-checks and builds `web/`
  - [ ] `phat-mode serve` explains how to build the dashboard if `web/dist/client` is missing
  - [ ] Check the SPA-mode option names and output paths against the current TanStack Start docs while setting up
  - [ ] Pick a styling approach (e.g. Tailwind) and record it under Decisions
- [ ] **Runs page**
  - [ ] One row per issue: repo, title, phase, status badge (working, PR opened, needs info, needs human, failed, ignored,
        blocked), budgets, cost, elapsed time
  - [ ] Live updates via `/api/events`; banner when the daemon restarts and runs resume
  - [ ] Totals: runs today, cost today
  - [ ] Repo filter (shows one repo for now; ready for several)
- [ ] **Run page**
  - [ ] Phase stepper with loop counts (Implement ⇄ Checks, Review rounds, Verify rounds)
  - [ ] Spec panel: source (Agent Brief / issue body), author, acceptance criteria, blockers
  - [ ] Plan panel
  - [ ] Agents panel: one tab per role, live transcript (assistant text, tool calls with output), model, cost
  - [ ] Two reviewers side by side, findings grouped by axis, never merged
  - [ ] Checks panel: last `checkCommand` output, attempt number
  - [ ] Verification panel: before/after screenshots and other evidence, drift, not-verified reasons
  - [ ] Outcome: PR link, hand-back reason, or failure reason with the last lines of the failing step
  - [ ] Cost panel: per role and per model, so it is clear where the money goes
  - [ ] Earlier runs of the same issue and how each ended
- [ ] Link out to the GitHub issue, the PR, and the branch
- [ ] Tests: API shapes the UI depends on (snapshot); one smoke test that the page loads and SSE delivers an update

## Phase 5: Dashboard controls

- [ ] Start a run by issue number
- [ ] Abort a run (with confirmation)
- [ ] Retry a failed or handed-back run
- [ ] Retry from a phase (e.g. from Review) using the stored checkpoint; work out which phases are safe to re-enter
- [ ] Send a steer to a working agent (`whenBusy: "steer"`); shown in its transcript as a human message
- [ ] Optional plan-approval gate (`config.approvePlan`, off by default): run waits after Plan; approve, edit, or
      reject in the dashboard
- [ ] Tests for each control through the API

## Phase 6: Notifications

- [ ] macOS notification when a run ends (PR opened, needs info, needs human, failed) and when a plan awaits approval
- [ ] Click opens the run page in the dashboard
- [ ] Config switch to turn them off

## Decisions

Record decisions here with a date.

- 2026-10-18: No terminal `watch` view; the local web dashboard is the main UI.
- 2026-10-18: Frontend is **TanStack Start** (replaces the earlier Next.js choice), in `web/`. Proposed: SPA mode,
  built to static files served by the daemon, so there is one process and one port and the daemon keeps sole
  ownership of the database. Start's server functions are not used. Revisit if a feature needs a Start server
  (none planned).
- 2026-10-18: The daemon starts **only by hand** (`phat-mode serve`); no `launchd` or auto-start.
- 2026-10-18: Cost is shown in **both** the dashboard and the GitHub status comment.
- 2026-10-18: **One repo for now, several later.** Not built yet, but nothing should assume one repo: API routes,
  run keys (`RunsDoc` already uses `owner/name#issue`), and dashboard rows carry the repo.

## Open questions

- Merge `MARKERS.plan` / `MARKERS.result` into the status comment, or keep them separate? (Phase 1)
- SPA mode vs. a Start server: confirm SPA mode when setting up `web/`. (Phase 4)

## Later: several repos

Not scheduled. Notes so the earlier phases do not block it:

- Config: `repos: [{ repo, baseBranch, checkCommand, installCommand, allowedAuthors, labels }]`, with today's
  top-level fields as defaults
- `services(config)` becomes per repo (GitHub client, workspaces, checks); the pipeline input already carries `repo`
- Workspaces are already under `workspaces/<repo>/issue-<n>`
- Polling (Phase 3) loops over repos; concurrency limit is global

## Session log

| Date | Done | Next |
|---|---|---|
| 2026-10-18 | Wrote this plan. Decided: TanStack Start (was Next.js), manual start, cost in dashboard and comment, multi-repo later. | Phase 1: status comment. |
