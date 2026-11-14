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
- Duplicate checks in one admission (on receive and again in `grant()`) run
  once.

What we lose: a deleted or replaced lock or database file is noticed within the
heartbeat interval rather than on the next write. Under assumption 2 that never
happens.

### Stage 2: caps that cause churn (lease close/reopen, refusals)

- `MAX_IDLE_EXECUTORS = 4` closes every idle agent database beyond four, so 145
  characters close and reopen their databases ~120 times a minute, each a
  synchronous state-database transaction plus integrity bookkeeping. Removed:
  every agent keeps one open executor.
- `MAX_STORES = 64` in the worker broker refuses stores beyond 64 ("SQLite
  worker queue capacity reached"). Removed.
- Process-local LRUs sized for small installs (history workers, rows cache) are
  sized for the whole cast.
- Per-agent SQLite page cache is lowered so ~150 open databases stay within a
  sane memory budget.

What we lose: memory headroom on huge installs (thousands of agents), which
Kazusa does not have. File descriptors are not a concern: Node raises its soft
limit to the hard limit at startup (measured: 256 → 1,048,575 on macOS).

### Stage 3: auth-profile usage bookkeeping (≈6% of code, ≈55% of worker ops)

Every successful model call records `lastUsed` for its auth profile, then
publishes the change by re-reading auth rows for every warmed agent snapshot
(O(agents) reads per call). With one credential per provider (assumption 5),
ordering and last-good have no effect. Success bookkeeping is skipped unless the
profile currently carries failure state (error count, cooldown, disabled), so
recovery from a provider outage still clears the cooldown. Failure bookkeeping
stays: it drives backoff.

### Stage 4: session and transcript side-work (≈11%)

- Session list row projection is no longer rebuilt eagerly on every transcript
  or entry event; it is built when someone reads the list.
- The session observer captures per-event state lazily, only when subscribed.
- Other per-append extras (FTS indexing, receipts, audit ledger) are cut or
  deferred where Kazusa never reads them. Each is decided in its own commit,
  with the reader search recorded.

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

(Filled in per commit: stage, cut, assumption, measured effect.)
