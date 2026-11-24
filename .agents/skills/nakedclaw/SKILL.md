---
name: nakedclaw
description: Why NakedClaw exists, what it assumes, what it cuts from OpenClaw 2026.10.5 and what it deliberately keeps, to run Kazusa's 145-character world on one Gateway. Use before changing, reviewing, rebuilding, benchmarking or rebasing anything in this fork, and whenever an upstream OpenClaw rule (AGENTS.md, docs) seems to forbid a NakedClaw change.
---

# NakedClaw

NakedClaw is OpenClaw 2026.10.5 (tag `v2026.10.5`, branch `naked`) with the
per-operation safety re-checks and bookkeeping taken off the Gateway's hot
paths. It exists for one product: Kazusa, a world simulator that runs one
OpenClaw agent per character (145 in the demo world) inside one Gateway.

Where this skill and the upstream `AGENTS.md` disagree, this skill wins for the
areas it lists. Everything else follows upstream rules.

## Why

Kazusa's capacity limit is the Gateway's main thread. Under a burst (121
characters due at once, 48 concurrent brains), stock OpenClaw spent its main
thread like this, with all Kazusa-side fixes applied:

| Share | What                                                                          |
| ----- | ----------------------------------------------------------------------------- |
| 23%   | ownership and identity guards (sync `realpath`, `stat`, lock-file read+parse) |
| 15%   | SQLite worker plumbing                                                        |
| 13%   | Kazusa's own code                                                             |
| 11%   | sessions and transcripts                                                      |
| 11%   | native (mostly the sync fs/env/clone work above)                              |
| 9%    | agent runs                                                                    |
| 6%    | auth-profile usage bookkeeping (and ~55% of all SQLite worker operations)     |
| 12%   | other, GC, diagnostics, timers                                                |

Most of the guard, plumbing, auth and session time re-proves facts that cannot
change in Kazusa's deployment, or maintains data nobody reads. Upstream needs
it because several processes (CLI, Doctor, updater, other Gateways) may touch
one state directory at any moment. Kazusa's deployment rules that out.

Method and raw data: `kazusa/.perf/demo/` (paired A/B rig, runs) and
`kazusa/.perf/naked/` (smoke test, analysis scripts).

## Assumptions (the contract every cut relies on)

1. **One process owns the state directory.** One Gateway per world. The web app
   never opens the databases; plugin CLI calls are RPCs into the Gateway.
   Doctor and migrations run only while the Gateway is stopped.
2. **Nobody else touches the files while the Gateway runs.** Users have no file
   system access in the deployed product. ARONA edits world content through
   tools and skills, never `.state/` databases or lock files, and never starts
   a second OpenClaw.
3. **The state directory never moves or gets replaced while running.** No
   renames, restores or symlink swaps under a live Gateway.
4. **Recovery comes from SQLite and a restart, not runtime checks.** WAL and
   transactions keep each database consistent across a crash; restart
   reclaims a dead pid's lock and resumes interrupted runs; Kazusa's git saves
   are the backstop.
5. **One credential per provider.** Auth-profile ordering and last-good choose
   nothing.
6. **Kazusa is the only product.** Features Kazusa does not use may cost
   nothing at runtime, but must keep working for anyone who does use them.
   Exceptions are listed in the Cut table: worlds are created on this version
   (no legacy session checks at start), and no plugin lives in a character's
   workspace.
7. **Credentials are shared.** Every agent uses the one shared credential store
   (`auth.sharedStore` in the state database). No agent has its own store:
   per-agent logins (`--agent`, plugin `AuthStorage.forAgent`) land in the
   shared one, and a cooldown applies to every agent.

If any of these stops being true (a second process opening state, a hosted
multi-tenant Gateway, file access for users), re-evaluate the cuts first.
Several would then be data-loss bugs.

## Cut

| Area              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Assumption |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Ownership         | The owner lock and projection sidecar are read once, then trusted. The heartbeat worker's "removed or replaced" report now calls `loseOwner` (upstream ignored it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2          |
| State paths       | Owner-lock path, canonical database path, agent-dir and session-candidate identities are memoized per path (`memoizeStatePathResolver`, bounded at 4,096). One `stat` per identity check instead of two.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 3          |
| Caps              | No `MAX_IDLE_EXECUTORS` (4): every agent keeps its database open until the 30 min idle TTL, a restart drain or shutdown. No 64-store cap. A full worker queue waits instead of failing after 10 s. Worker task pools accept 4,096 pending tasks, not 128.                                                                                                                                                                                                                                                                                                                                                                                                            | 1          |
| Auth              | A successful model call writes usage only when the profile has failure state, or a failure was recorded in this process since its last success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 5          |
| Session rows      | Rebuilt by the next reader instead of after every per-session change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 6          |
| Streaming         | Runs hidden from the Control UI that reply only through the message tool, with no block or reasoning streaming (Kazusa's brains), set the existing `suppressLiveStreamOutput`: the text buffer fills, per-token parsing and its event fan-out are skipped.                                                                                                                                                                                                                                                                                                                                                                                                           | 6          |
| Session observer  | Skips an event entirely when it tracks no state and no connection can see the session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 6          |
| Agent DB paths    | `isConfiguredAgentDatabaseTarget` checks exact configured claims across all targets before probing any file for an alias; checking every agent against the list used to stat and realpath each earlier target first. Same answers.                                                                                                                                                                                                                                                                                                                                                                                                                                   | —          |
| Session startup   | No legacy file-store, ACP, main-key or run-outcome checks per agent, and no eager canonical validation pass; the canonical-validation worker pool that only startup used is deleted, and `certifySessionCanonicalValidationPending` takes only the pending work a runtime read or change captured. A database without a receipt (a copied or restored world, or one that was empty when last certified) is validated at its first session read or change instead: on the main thread, or by a worker that records the receipt on the Gateway's session-row and request paths.                                                                                        | 1, 6       |
| Recovery          | Publishing a recovered agent no longer refreshes secrets, compares the secrets revision, or requires its model runtime to still be published when admission completes; only a config change supersedes it. A model runtime superseded by a live credential write is republished by the runtime itself; build errors still refuse the agent.                                                                                                                                                                                                                                                                                                                          | 7          |
| Unclean start     | A database with no clean-close record (an unclean stop, a copied world, a new version) is admitted at startup like any other; it used to wait for a serial background recovery turn (open, session maintenance, model runtime republication) while its agent refused work. Startup also no longer awaits a chat-metadata refresh after publishing the model runtime: the chat-metadata lifecycle refreshes on every publication, and the awaited one stopped the Gateway when it ran during a recovering agent's republication.                                                                                                                                      | 4          |
| Plugin index      | A native-admission overlay of the installed index reuses the index's fingerprint (the fingerprint already leaves admissions out).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —          |
| Plugin workspace  | In a world with a default workspace, every agent's plugin metadata and registry load for the Gateway's plugin workspace, so agents borrow the Gateway's registry. Applies to `agent` CLI runs in another cwd too.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 6          |
| Credentials       | One rule, in every world: an agent directory names the shared store unless a scoped `agent --local` or onboarding run owns it (`resolveRuntimeAuthProfileAgentDir`, `isScopedAuthProfileAgentDir`). `resolveAuthProfileStorePath` applies it where a store is opened and where runtime snapshot keys and secret owner ids are made; other agent databases' auth rows are not read (`sqlite-read.ts`). The secrets snapshot holds one shared entry, recovery no longer refreshes secrets per agent, `secrets apply` targets the shared store once, migration and source checks and display paths name the shared store, and inline API-key failures are not recorded. | 7          |
| Event-loop health | Node's native `monitorEventLoopDelay` replaces a 20 ms JS job on the Gateway scheduler, whose every wake rescanned all scheduled jobs. Health is computed once a second.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —          |

What these cost us, and how loss is detected now:

- **A deleted or replaced root lock** stops the Gateway within one heartbeat
  (15 s) instead of failing the next write. If the heartbeat worker stalls,
  `heartbeat.inspect()` re-verifies after 60 s. Reports after the owner's final
  release are ignored.
- **The projection sidecar** (`gateway.state.lock`) is not watched: losing it
  goes unnoticed until restart.
- **Database file identity** is still `stat`ed on every check; that is what
  catches OpenClaw's own delete-and-recreate of a database.
- **~145 open databases**: ~3 fds and up to ~2 MB page cache each. Node lifts
  the fd limit at startup (measured 256 → 1,048,575). Shutdown closes them all
  (measured 4.7 s, inside the 10 s native-close reserve). A forced exit leaves
  `-wal` files that SQLite replays on next open; anything snapshotting a world
  must checkpoint first or include them. Same recovery as upstream.
- **Unclean starts**: no integrity check is dropped. The first open still runs
  the gate in a worker: WAL databases defer to the background full check, and a
  database whose dead owner cannot be proven (a hard kill) is checked in full at
  open. A corrupt non-WAL database now fails at its first open instead of being
  refused at startup with a repair hint. The recovery queue remains for databases
  whose startup inspection takes over 5 s and for startup index repair.
- **Queue refusals** are gone for the 128-request case only; the 256 MB queued
  byte budget and oversized inputs still refuse at once.
- **Auth counters**: an expired cooldown cleared in memory can leave stale
  counters on disk until the next failure (status displays only).
- **Control UI**: live lifecycle events may lack row enrichment until a read;
  brains show no live text (they never did: hidden runs' deltas carry no
  session key); observation of a session starts at its next run after a viewer
  connects.
- **Credentials**: one agent's auth or billing failure cools the profile down
  for every agent. A key written inline in config (not an auth profile) gets no
  cooldown at all; Kazusa saves keys as shared profiles. Leftover rows in an
  agent database's auth tables are ignored, not migrated. In a scoped
  `agent --local` run, an auth write made from a worker thread cannot see the
  scope and goes to the shared store. An empty shared store
  saved beside a legacy `oauth.json` records no migration refusal; Doctor imports
  older credentials.
- **Plugin workspace**: a plugin placed in one character's workspace would not
  load for anyone; one in the default workspace would load for everyone.
- **Liveness**: run liveness timestamps are refreshed by agent events. Without
  per-token events, a single model reply longer than 10 minutes would look
  stale to steer admission. Provider-level idle timeout and stuck detection are
  unaffected: they watch raw provider chunks.

## Kept, and why

- **The owner lock at startup and its heartbeat worker**: two Gateways can
  never open one world; a crashed Gateway's lock is reclaimed. Costs the main
  thread nothing.
- **SQLite WAL, transactions, `busy_timeout`, startup migrations, restart
  recovery**: these are what make a crash recoverable.
- **Stuck-session detection and diagnostics**: they explained the shutdown hang
  found during this work.
- **Admission's access re-check in `grant()`**: cutting it was tried and
  reverted. After the cuts above it costs ~0.05%, and it is the only guard if
  an `admit` callback revokes the owner before granting.
- **Provider streaming and the agent's own per-token event**: the LLM idle
  timeout and stuck detection run on provider chunks, and the text buffer keeps
  partial text when a run hits its time budget.
- **Control UI, session observer, live streaming display**: kept for anyone who
  watches, skipped when nobody does (see Cut). Deleting them saves nothing more
  at runtime.
- **Worker threads for SQLite**: running small operations in-process on the
  main thread would remove most remaining plumbing (~13%), but it adds a second
  execution mechanism instead of deleting one, and puts SQL on the bottleneck
  thread. Rejected.
- **Cron and the Gateway scheduler**: cron arms one timer per store, not one
  per job; its cost to Kazusa is indirect and is removed on the Kazusa side
  (wakes from Taskman's own timer). The scheduler serves OpenClaw's own
  subsystems; only its 20 ms sampler was a problem.
- **Sandbox path checks for agent file tools**: never memoized.
- **The `openclaw` package name, exports and plugin SDK**: provider plugins and
  Kazusa import `openclaw/plugin-sdk/*`.
- **Cold paths** (startup, Doctor, CLI, updater): no runtime cost; their checks
  protect stopped-Gateway workflows.
- **Prompt construction and transcript bytes**: simulation quality and prompt
  caching are never traded for speed.

## Where the remaining time goes

NakedClaw's main thread in the final pair (`f1`, burst minute plus a later
minute, 29 s busy):

| Share | What                                                                                               | Why it stays             |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| 21%   | Kazusa's own code (memory retrieval 7%, perception 5%, chat observation 2% from the rig's monitor) | Kazusa's to optimize     |
| 19%   | native: V8 unattributed `(program)` 7%, timers and microtasks 3%, provider HTTP/SSE/TLS 3%         | runtime                  |
| 13%   | SQLite worker plumbing: brains' transcript turns, plugin state, admission                          | real writes; see Kept    |
| 12%   | agent runs: the agent loop, tool construction ~1%, provider fetch                                  | the work itself          |
| 11%   | sessions and transcripts: prompt-cache key ~1.3%, skill snapshot 0.6%, entry writes                | mostly needed            |
| 7%    | other: provider stream transport ~2%, event listeners ~0.8%                                        | runtime                  |
| 5%    | auth store: per-run API key resolution ~1.5%                                                       | candidate                |
| 4%    | guards left: admission identity, transcript target resolution                                      | needed (identity `stat`) |
| 4%    | diagnostics: prompt-phase redaction/trajectory ~1.2%, diagnostic events                            | candidate                |
| 4%    | GC                                                                                                 | allocation pressure      |
| 1%    | Gateway scheduler                                                                                  | was 2–3%                 |

Candidates worth chasing next, largest first, each to be measured before
cutting: per-run API key resolution (~1.5%, one key per provider); run
trajectory recording and its redaction (~1.2%, nobody reads it); the
prompt-cache key hash (~1.3%); tool construction per run (~1%); skill snapshot
per run (0.6%). On the Kazusa side: the wiki index re-walk (~2–3%) and copying
every chat into each recipient's OpenClaw transcript (part of the 13% + 11%,
needs its own experiment).

## Results

Final pair `f1` (2026-11-15): two clones of the 145-character snapshot side by
side, the same Kazusa (PR branch) on both, 48 brains, clock jumped 60
sim-minutes, 15 minutes. Stock 10.5 vs NakedClaw:

|                                             | stock | NakedClaw   |
| ------------------------------------------- | ----- | ----------- |
| OpenClaw main ms per model call (no Kazusa) | 279   | 177 (−37%)  |
| process CPU, cores                          | 0.81  | 0.46 (−43%) |
| worker ops per model call                   | 221   | 80 (−64%)   |
| auth writer ops/min                         | 5,632 | 21          |
| worst event-loop stall                      | 1.7 s | 0.34 s      |
| main thread busy                            | 49%   | 33%         |

"No Kazusa" subtracts Kazusa's own code from the profiled minutes; whole-run
main time per model call including Kazusa went 348 → 267 ms (−23%). Earlier
pairs `n1` and `n2` (before the last three cuts) measured −23% and −34% per
model call; throughput in each pair was demand- or provider-limited, so per-call
main time is the robust number.

Three independent Opus reviews of stages 1–4 found no data loss, deadlock or
blocked recovery under the assumptions. Their real findings (auth cooldowns
not cleared by concurrent successes, a false loss report on release, an
unbounded memo, a dead re-check) are fixed.

### Startup and recovery

Mac, the 145-character snapshot after an unclean stop (Windows almost always
stops uncleanly), Kazusa's two config settings applied
(`kazusa/.perf/naked/startup/ctl.sh`):

|                                      | before   | after     |
| ------------------------------------ | -------- | --------- |
| listening                            | ~18 s    | 11 s      |
| all 145 characters recovered         | 10.6 min | 1:12–1:31 |
| recovery models step, all characters | ~400 s   | ~47 s     |
| characters left degraded             | 1–2      | 0         |

A clean boot listens at about 14 s. Recovery is now limited by opening the
character databases (`open-wait`), not by preparing them.

With unclean starts admitted directly (2026-11-18), the same snapshot is ready
(`sidecars.ready`) about 20 s after start with no character refused, like a
clean boot; before, the last character recovered at about 110 s. A hard-killed
Gateway restarts the same way.

## Rules for working in this fork

- **Every cut names its assumption** in a `NakedClaw:` code comment and in its
  commit message.
- **Delete what Kazusa never needs; skip what someone might watch.** A feature
  that is useful when observed (Control UI, observer, streaming display) stays
  and costs nothing when unobserved. No config switches for cuts.
- **Tests follow the code.** Tests of removed behavior are rewritten to assert
  the new contract or deleted with a `NakedClaw:` note. A test that waits on a
  removed timeout hangs until vitest's limit and stalls the rest of its file:
  run fork tests under a watchdog (`perl -e 'alarm 1500; exec @ARGV' pnpm test …`)
  and pass file lists word-split (`${=T}` in zsh).
- **One commit per cut**, Conventional Commits, `perf(naked): …`.
- **Never edit `dist/` or `node_modules/`.** Change `src/` and rebuild.
- **Measure before cutting**, with the paired rig; judge by same-pair deltas.

## Build, run and benchmark

- Node 24; pnpm via corepack (`corepack enable --install-directory ~/.local/bin`,
  then `PATH=~/.local/bin:$PATH`); `pnpm install --frozen-lockfile` once.
- OpenClaw always runs from built `dist/`. Runtime-only rebuild, ~30 s:
  `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 node --import ./scripts/tsx.mjs scripts/build-all.mts gatewayWatch`.
  Full build with declarations, ~2 min: `pnpm build`.
- Kazusa runs on the fork uninstalled: its perf launcher takes a package root
  (`KZ_OPENCLAW=/path/to/nakedclaw`).
- Checks: `pnpm tsgo:core`, the touched tests, `scripts/run-oxlint.mjs` and
  `oxfmt` on changed files, then in Kazusa's repo `.perf/naked/smoke.sh` and a
  paired burst with `.perf/demo/run-pair3.sh` (`OPENCLAW_B=<nakedclaw root>`;
  `CHAR_DENY_A/B` applies Kazusa's per-character tool denies).
- Analysis: `.perf/demo/report-pair.py`, `.perf/naked/percall.py` (main ms per
  model call by area), `bucketdetail.py`, `callers.py`.
- Startup and recovery: Kazusa's `.perf/naked/startup/ctl.sh` (prepare, start,
  wait-recovered, summary, stop) boots a copy of the unclean 145-character
  snapshot; per-agent recovery phases are in the JSON log
  (`/tmp/openclaw/openclaw-<date>.log`, "recovered after background" records).
- Shipping: `node scripts/naked-pack.mjs --name <version>-naked-<n>` (builds,
  then packs as upstream's npm release does: `@openclaw/ai` stays a dependency
  on npm's package of the same version, not a bundled copy), published as a
  GitHub release asset that Kazusa depends on by URL. It refuses while
  `packages/ai` differs from the upstream tag: npm's package would then not be
  this code. Never a git dependency: `dist/` is not in git. Releases up to
  0.2.1 bundled `@openclaw/ai` (Docker's packaging), which left installs that
  had it at the top level without either copy after an `npm install`.

## Upstream

Following upstream releases ends here. Pick fixes by hand, security first.
Known candidate: the keyed-store v2 API with multi-store transactions (2026.11.x).

## Commits

Base `v2026.10.5` (1b58cb9a1b4).

1. `perf(naked): trust verified state ownership and memoize state paths`
2. `perf(naked): remove executor, store and queue caps`
3. `perf(naked): skip auth success bookkeeping for clean profiles`
4. `perf(naked): materialize session rows on read`
5. `fix(naked): address review findings`
6. `perf(naked): skip live stream output for runs nobody watches`
7. `perf(naked): skip session observer work when nobody watches`
8. `perf(naked): sample event-loop delay with Node's native monitor`
9. `perf(naked): check exact agent database claims before probing files`
10. `perf(naked): drop legacy session startup checks and the startup validation pass`
11. `perf(naked): share the plugin index fingerprint with admission overlays`
12. `perf(naked): load every agent's plugins for the Gateway workspace`
13. `perf(naked): use one shared credential store for every agent`
14. `docs(naked): record startup and recovery cuts`
15. `fix(naked): stop awaiting a chat-metadata refresh at startup`
16. `perf(naked): admit databases without a clean-close record at startup`

Tests run for 9–13: `src/secrets/*` (runtime, fast path, apply, admission,
inline refs, state), `src/agents/auth-profiles/*`, `src/agents/sessions/auth-storage*`,
`src/agents/model-auth*`, `src/agents/prepared-model-runtime.*` (plugin context,
inbound and startup registries, registry borrow, auth recovery),
`src/plugins/manifest-registry-installed*`, `plugin-native-admission-*`,
`src/config/plugin-auto-enable.*`, `src/config/sessions/startup-migration.*`,
`session-canonical-validation-readiness`, `session-accessor.sqlite-*worker*`,
`targets*`, `src/gateway/server-agent-database-startup*`,
`session-startup-migration`, `session-row-prepared-read`,
`server-methods.canonical-validation` (fixed for cut 4), and Doctor's auth and
maintenance tests.

Tests run for 1–8: storage (`src/infra/gateway-*`, `sqlite-worker*`, `sqlite-store*`,
`src/state/openclaw-agent-*`, `openclaw-state-db*`,
`src/config/sessions/session-store-*`, `session-accessor*`),
`src/agents/auth-profiles/*`, `src/gateway/session-row-projection*`,
`session-observer*`, `server-runtime-subscriptions*`,
`server/event-loop-health*`, `src/auto-reply/reply/agent-runner-execution*`,
`src/process/gateway-work-admission`. The full OpenClaw suite has not been run.
