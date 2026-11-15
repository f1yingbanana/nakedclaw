---
name: nakedclaw
description: Why NakedClaw exists, what it assumes, and what it strips from OpenClaw 2026.10.5 to run Kazusa's 145-character world on one Gateway. Use before changing, reviewing, rebuilding, benchmarking or rebasing anything in this fork, and whenever an upstream OpenClaw rule (AGENTS.md, docs) seems to forbid a NakedClaw change.
---

# NakedClaw

NakedClaw is OpenClaw 2026.10.5 (tag `v2026.10.5`, branch `naked`) with the
per-operation safety and bookkeeping machinery removed from the Gateway's hot
paths. It exists for one product: Kazusa, a world simulator that runs one
OpenClaw agent per character (145 in the demo world) inside one Gateway.

Where this skill and the upstream `AGENTS.md` disagree, this skill wins for the
areas it lists. Everything it does not list follows upstream rules.

## Why

Kazusa's capacity limit is the Gateway's main thread. With all Kazusa-side fixes
and stock OpenClaw, a burst (121 characters due at once, 48 concurrent brains)
keeps the main thread saturated, and the measured exclusive breakdown of its
busy time was:

| Share | What                                                                          |
| ----- | ----------------------------------------------------------------------------- |
| 23%   | ownership and identity guards (sync `realpath`, `stat`, lock-file read+parse) |
| 15%   | SQLite worker plumbing (admission round trips, env clones, per-op channels)   |
| 13%   | Kazusa's own code                                                             |
| 11%   | sessions and transcripts (row projection, observers, FTS, receipts)           |
| 11%   | native (mostly the sync fs/env/clone work above)                              |
| 9%    | agent runs                                                                    |
| 6%    | auth-profile usage bookkeeping (and ~55% of all SQLite worker operations)     |
| 12%   | other, GC, diagnostics, cron                                                  |

Roughly 60-65% of main-thread time is spent re-proving facts that cannot change
in Kazusa's deployment, or maintaining data nobody reads. Upstream keeps these
checks because OpenClaw is a general product: several processes (CLI, Doctor,
updater, other Gateways) may touch one state directory at any moment. Kazusa's
deployment rules that out, so NakedClaw drops them.

Numbers and method: `kazusa/.perf/demo/` (paired A/B rig) and
`kazusa/.perf/openclaw-patches/fork-candidates.md` (the ranked cut list this
fork implements).

## Assumptions (the contract every cut relies on)

1. **One process owns the state directory.** One Gateway runs per world. The
   web app never opens the databases; Kazusa's plugin CLI calls are RPCs into
   the Gateway. Doctor and migrations run only while the Gateway is stopped
   (Kazusa's `dev.mjs` and installer already do this).
2. **Nobody else touches the files while the Gateway runs.** Users have no file
   system access in the deployed product. ARONA (the world-building agent)
   operates safely: she edits world content through tools and skills, never the
   `.state/` databases or lock files, and never starts a second OpenClaw.
3. **The state directory never moves or gets replaced while running.** Local
   disk; no renames, restores or symlink swaps under a live Gateway. Restores
   and world updates happen with the Gateway stopped.
4. **Recovery comes from SQLite and a restart, not from runtime checks.** WAL
   plus transactions keep every database consistent across a crash. On restart
   OpenClaw reclaims a dead pid's lock and resumes interrupted runs. Kazusa's
   git saves (worlds as git clones) are the backstop for anything worse.
5. **One credential per provider.** Auth-profile rotation, ordering and
   last-good tracking have nothing to choose between.
6. **Kazusa is the only product.** Channels, multi-user features, updater flows
   and anything Kazusa does not use may be slow or removed, but must not break
   the paths Kazusa does use.

If a change would make any of these false (a second process opening state, a
hosted multi-tenant Gateway, file access for users), the cuts below must be
re-evaluated first. Several of them would then be data-loss bugs.

## What stays (non-negotiable)

- **The owner lock at startup** and its background heartbeat worker: two
  Gateways can never open one world, and a crashed Gateway's lock is reclaimed.
  The heartbeat runs on its own thread and costs the main thread nothing; its
  loss signal now reaches the owner (upstream ignored it).
- **SQLite WAL, transactions, `busy_timeout`, schema migrations at startup.**
  These are what make a crash recoverable.
- **Restart recovery** of interrupted runs and sessions.
- **Stuck-session detection** (diagnostics), unless Kazusa takes it over.
- **Worker threads for long or heavy jobs** (migrations, checkpoints, large
  history reads), so the event loop never stalls for seconds.
- **Sandbox path checks for agent file tools.** `resolveIdentityPathViaExistingAncestorSync`
  also guards file-tool boundaries; it is never memoized globally. Only the
  state-database callers get cached identities.
- **The `openclaw` package name, exports and plugin SDK.** Provider plugins and
  Kazusa import `openclaw/plugin-sdk/*`; NakedClaw installs as an npm alias of
  `openclaw`.

## What gets stripped, and why

Stages are applied in order, rebuilt and A/B-measured after each. The strip log
at the end records what each stage actually changed.

### Stage 1: ownership and identity re-checks (≈23% of main time)

Upstream re-proves physical ownership on almost every state-database access:
`realpath` of the database and lock directory, `stat` of the database file, and
an open/read/parse of the owner lock file, often several times per operation
(receive and grant in admission, `assertCurrent` in leases, auth writes, reads).

- Owner-lock path, canonical database path and database file identity are
  computed once per path and memoized (assumption 3).
- A Gateway that holds its owner in memory trusts it: no per-access lock-file
  verification. Loss of the lock is detected by the heartbeat worker (now wired
  to `loseOwner`) instead of by the next write (assumption 2).
- Admission still checks access on receive and again in `grant()`. Cutting the
  second check was tried and reverted: after the cuts above it costs ~0.05% of
  main time, and it is the only guard if an `admit` callback revokes the owner
  before granting (a shared-state test does exactly that).

What we lose, and how loss is now detected:

- The heartbeat worker renews the root owner lock every 15 s through a held fd
  and reports ENOENT or a replaced inode. That report aborts `owner.lost`, and
  the Gateway closes (`gateway/server.ts`). So anything that deletes or
  replaces the root lock stops the Gateway within ~15 s instead of failing the
  next write. If the worker itself stalls, `heartbeat.inspect()` on the main
  thread renews and re-verifies after 60 s.
- Reports delivered after the owner's final lock release are ignored (one can
  be queued just before `stop()`).
- The projection sidecar (`gateway.state.lock`) is not watched at all: the
  worker silently forgets non-root locks, and the parent no longer re-reads it.
  Losing it goes unnoticed until restart.
- Database file identity (dev/ino/birthtime) is still read on every check; that
  `stat` is what catches OpenClaw's own delete-and-recreate of a database.
- The path memo covers every SQLite path that goes through
  `resolveDatabasePathKey`, including temporary snapshot and staging
  databases, so it is bounded (cleared at 4,096 entries).
- Worker threads still read the lock file per access (their owner map is empty);
  that costs worker time, not main-thread time.

### Stage 2: caps that cause churn (lease close/reopen, refusals)

- `MAX_IDLE_EXECUTORS = 4` closes every idle agent database beyond four, so 145
  characters close and reopen their databases ~120 times a minute, each a
  synchronous state-database transaction plus integrity bookkeeping. Removed:
  every agent keeps one open executor.
- `MAX_STORES = 64` in the worker broker refuses stores beyond 64 ("SQLite
  worker queue capacity reached"). Removed.
- A full per-worker queue (128 requests) waits instead of failing after 10 s;
  that refusal used to become a boot-long "inspection-failed" refusal of the
  agent. The 256 MB queued-bytes budget and oversized inputs still refuse at
  once, and waiters hold their bytes in that budget, so a stalled slot can
  still cause the old refusal on other slots under extreme load.
- Idle executors stay open until `SQLITE_IDLE_HANDLE_TTL_MS` (30 min), a
  restart drain or shutdown: ~3 fds and up to ~2 MB page cache each. Their
  drain listeners make the restart-drain signal unlimited-listener.
- Shutdown now closes ~145 open agent databases (each a WAL checkpoint) within
  the 10 s native-close reserve. A forced exit leaves `-wal` files, which SQLite
  replays on the next open. Anything that snapshots a world (git saves) must
  checkpoint first or include the `-wal` files.
- With `shareWorkers=false` (Bun only, not Node) the removed store cap means
  one worker thread per store.
- Worker task pools accept 4,096 pending tasks instead of 128, so a full
  cast's startup burst is not refused.
- Per-agent SQLite page cache stays at SQLite's default unless the A/B shows
  memory pressure from ~150 open databases.

What we lose: memory headroom on huge installs (thousands of agents), which
Kazusa does not have. File descriptors are not a concern: Node raises its soft
limit to the hard limit at startup (measured: 256 → 1,048,575 on macOS).

### Stage 3: auth-profile usage bookkeeping (≈6% of code, ≈55% of worker ops)

Every successful model call records `lastUsed` for its auth profile, then
publishes the change by re-reading auth rows for every warmed agent snapshot
(O(agents) reads per call). With one credential per provider (assumption 5),
ordering and last-good have no effect. Success bookkeeping is skipped unless the
profile carries failure state (error count, failure counts, cooldown, blocked
or disabled window) in the run's store, or this process recorded a failure for
it since its last success write (`noteAuthProfileFailureRecorded`). The second
condition matters: each run checks its own store copy, which predates failures
recorded by concurrent runs, and one inherited cooldown covers every agent.
Without it a single 429 during a burst would stall the whole cast for the
cooldown window. Failure bookkeeping stays: it drives backoff.

Leftover: when an expired non-rate-limit cooldown is cleared in memory by
ordering, its stale counters stay on disk until the next failure. Behavior is
unaffected; only status displays show them.

### Stage 4: session and transcript side-work (≈11%)

- Session list row projection is no longer rebuilt eagerly on every
  per-session transcript or entry event; the next reader materializes it.
  Readers either await `ensureMaterialized()` (sessions.resolve, cron, list)
  or tolerate dirty rows (`describe` refreshes them from retained facts,
  `selectEntries` acquires them). Global changes still refresh eagerly. Cron
  job events also drain materialization, so with cron wakes the saving is
  batching rather than elimination; the first `sessions.list` after a burst
  pays the refresh. Gateway WebSocket clients (Control UI) may get live lifecycle events
  without row enrichment until they read; Kazusa does not use them.
- Measured and left alone: the transcript-update broadcaster (<0.2%, already
  cheap without subscribers) and the session observer's per-event read capture
  (0.7%; its captured identity is part of a stale-read fence).
- FTS indexing, receipts and the audit ledger were not hot enough in the
  profiles to cut blind; revisit with the post-strip profile.

### Stage 5: worker handoff for small operations (≈15%)

Each SQLite operation clones the environment, captures a state context, does
dynamic imports, builds a new `MessageChannel` and `SharedArrayBuffer` for
admission, ships the whole context, and answers several admission round trips
while the worker sits inside `BEGIN`. Under assumptions 1-2 admission has no
one to exclude. The cut keeps the worker model but removes per-operation
ceremony (cached context, hoisted imports, pre-granted admission). Running small
operations in-process on the main thread is the next step if this is not enough;
it is measured before it is attempted.

### Not stripped

- Cold paths (startup, Doctor, CLI one-shots, updater): they cost nothing at
  runtime and their checks protect the stopped-Gateway workflows.
- Prompt construction and transcript bytes: these change model behavior and
  prompt caching. Simulation quality is never traded for speed here.
- Anything measured below ~0.5% of main-thread time unless it falls out of a
  cut above.

## Rules for working in this fork

- **Every cut names the assumption it relies on** in its commit message, and
  in a short code comment at the cut (`NakedClaw: <assumption>`), so a future
  reader can re-evaluate it.
- **Delete, don't flag.** Remove dead code and its tests rather than adding
  switches. A debug switch is allowed only where a cut removes a safety check
  that is useful while debugging (named `OPENCLAW_NAKED_*`).
- **Tests follow the code.** Tests that assert removed behavior are deleted in
  the same commit; tests for kept behavior must still pass.
- **One commit per cut**, Conventional Commits, `perf(naked): ...`.
- **Never edit `dist/` or `node_modules/`.** Change `src/` and rebuild.

## Build, run and benchmark

- Toolchain: Node 24, pnpm via corepack (`corepack enable --install-directory ~/.local/bin`,
  then `PATH=~/.local/bin:$PATH`). `pnpm install --frozen-lockfile` once.
- OpenClaw always runs from built `dist/`; there is no run-from-TypeScript mode
  (`pnpm openclaw` rebuilds stale `dist/` first). Runtime-only rebuild, ~30 s:
  `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 node --import ./scripts/tsx.mjs scripts/build-all.mts gatewayWatch`.
  Full build with declarations (for packaging), ~2 min: `pnpm build`.
- While iterating, Kazusa runs on the fork without installing it: the perf
  launcher takes a package root (`KZ_OPENCLAW=/path/to/nakedclaw`), and the
  repo root is a valid package root once built.
- Checks per stage: `pnpm tsgo:core` (types), the touched modules' tests
  (`pnpm test <file>`), then in Kazusa's repo `.perf/naked/smoke.sh` (boot and
  routes) and a paired burst A/B with `.perf/demo/run-pair3.sh`
  (`OPENCLAW_B=<nakedclaw root>`). Judge by same-pair deltas: main ms per model
  call, worker ops/min, error lines, wake correctness (`overdue.py`), state
  consistency (`consistency.mjs`).
- Shipping to Kazusa: `pnpm build`, `npm pack`, and depend on the tarball as an
  alias: `"openclaw": "file:vendor/nakedclaw-2026.10.5-naked.N.tgz"` (or a
  published `npm:@scope/nakedclaw@...`). Never a git dependency: installing
  from git would need the whole pnpm toolchain on every machine.

## Upstream

Following upstream releases ends here. Pick fixes by hand (security fixes
first), rebasing them onto the stripped code. Candidates already known: the
keyed-store v2 API with multi-store transactions in 2026.11.x.

## Strip log

Base: `v2026.10.5` (1b58cb9a1b4). Stock attribution is from four burst-minute
profiles (`kazusa/.perf/demo/runs/r4/a`, `r5/b`).

| Commit                                                                | Stage | Cut                                                                                                                                                                                                              | Assumption | Stock share it targets                                                                                                                     |
| --------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `perf(naked): trust verified state ownership and memoize state paths` | 1     | owner lock + projection read once, heartbeat loss wired to `loseOwner`; owner path, canonical DB path, agent-dir and session-candidate identities memoized (`memoizeStatePathResolver`); one `stat` per identity | 2, 3       | `assertStateDatabaseAccessAllowed` 8.2%, `resolveDatabasePathKey` 6.0%, read candidates 1.6%, admission grant re-check ~2.6% (overlapping) |
| `perf(naked): remove executor, store and queue caps`                  | 2     | no `MAX_IDLE_EXECUTORS`, no `MAX_STORES`, queue waits instead of 10 s refusal, pending tasks 128 → 4096                                                                                                          | 1          | ~120 lease close/reopen cycles/min; boot-long agent refusals                                                                               |
| `perf(naked): skip auth success bookkeeping for clean profiles`       | 3     | success writes only when failure state exists                                                                                                                                                                    | 5          | ~3,800 auth writer ops/min, `publishInlineAuthFailure` 3.3%                                                                                |
| `perf(naked): materialize session rows on read`                       | 4     | no eager row refresh for per-session changes                                                                                                                                                                     | 1, 6       | row refresh ~1.7%                                                                                                                          |
| `fix(naked): address review findings`                                 | 1-3   | see Review below                                                                                                                                                                                                 | 1, 2, 5    | —                                                                                                                                          |

Stage 5 (worker ceremony) is deferred: after Stage 1 its remaining measured
pieces are each ≤0.5% (env merge 0.5%, state context 0.3-0.6%, per-op admission
channel 0.4%). The post-strip profile decides whether in-process execution of
small operations is worth its risk.

### Measured: pair `n1` (stages 1-4, 2026-11-15)

Stock 10.5 vs NakedClaw, two clones of the 145-character snapshot side by side,
same Kazusa plugin (all perf fixes), 48 brains, clock jumped 60 sim-minutes
(burst), 15 minutes (`kazusa/.perf/demo/runs/n1`):

|                                | stock  | NakedClaw     |
| ------------------------------ | ------ | ------------- |
| main ms per model call         | 347    | 266 (−23%)    |
| main ms per (model + Jev) call | 126    | 94 (−25%)     |
| process CPU, cores             | 0.67   | 0.44 (−34%)   |
| worker ops/min                 | 14,403 | 5,588 (−61%)  |
| auth writer ops/min            | 4,250  | 21            |
| burst-minute main busy         | 46.4 s | 23.8 s (−49%) |
| of which DB guards             | 10.2 s | 1.2 s         |
| of which worker plumbing       | 7.4 s  | 3.1 s         |
| of which sessions/transcripts  | 5.2 s  | 3.0 s         |

Throughput was demand-limited in this pair (65-68 model calls/min both); the
gain is headroom. After stage 4 no OpenClaw function exceeds ~2% self time:
file-identity `stat` 1.6%, env clones ~1.9% spread over ten callers.

### Measured: pair `n2` (after review fixes, 2026-11-15)

Same setup as `n1` (`kazusa/.perf/demo/runs/n2`):

|                                | stock  | NakedClaw  |
| ------------------------------ | ------ | ---------- |
| model calls/min                | 46.0   | 68.7       |
| brain runs/min                 | 24.4   | 32.0       |
| main thread busy               | 33%    | 33%        |
| main ms per model call         | 432    | 284 (−34%) |
| main ms per (model + Jev) call | 183    | 126 (−31%) |
| worker ops per model call      | 226    | 85 (−62%)  |
| process CPU, cores             | 0.57   | 0.53       |
| burst-minute main busy         | 45.2 s | 30.5 s     |
| loop delay p99 worst           | 514 ms | 1,447 ms   |

Same main-thread load carried ~49% more model calls. Provider timeouts
(DeepSeek) differed between sides (89 vs 41 failed runs), so the throughput
gap carries provider noise; per-call main time is the robust number (−23% in
`n1`, −34% here). Both Gateways then waited out upstream's 315 s shutdown drain
for brain runs blocked in tools: unchanged upstream behavior.

### Review (three independent Opus reviews, 2026-11-15)

No cut was found to lose or corrupt data, deadlock, or block restart recovery
under the assumptions. Fixed after review: success bookkeeping for failures
recorded by concurrent runs (above); heartbeat reports after final release;
the admission `grant()` re-check, restored to upstream (the cut saved ~0.05%
and dropped a guard a test exercises); unbounded path memo; restart-drain listener warning; comments citing
stages instead of assumptions; loosened or outdated tests. Accepted and
documented above: projection sidecar loss, byte-budget refusals, shutdown WAL,
stale on-disk auth counters, Control UI enrichment.

Tests changed by the fork, after review: tests that waited for removed
timeouts or refused at removed caps (10 s queue/open timeout, 64 stores, 128
pending tasks, 4 idle executors), tests of symlink retarget under state paths,
and tests that expected a clean auth success to write `lastUsed`/`lastGood` are
deleted or rewritten to assert the new contract. A test that waits on a removed
timeout does not fail fast: it hangs until vitest's limit and stalls the
workers for the rest of its file, so run fork tests with a watchdog
(`perl -e 'alarm 1500; exec @ARGV' pnpm test ...`). Last run: 212 touched test
files, all passing (11 min).

Known simplification left: on POSIX, `isSessionStoreReadCandidateCurrent`
compares two memoized values and is always true, so its "selector changed
during discovery" refusal is unreachable. Removing that machinery is a larger
cut than its cost justifies today.

### Tests run per stage

`pnpm tsgo:core`; storage (`src/infra/gateway-*`, `sqlite-worker*`,
`sqlite-store*`, `src/state/openclaw-agent-execution*`, `openclaw-state-db*`,
`openclaw-agent-db*`, `src/config/sessions/session-store-*`,
`session-accessor*`), `src/agents/auth-profiles/*`,
`src/gateway/session-row-projection*`, `server-session-events*`,
`src/process/gateway-work-admission`; changed files through
`scripts/run-oxlint.mjs` and `oxfmt`. The full OpenClaw suite has not been run.
