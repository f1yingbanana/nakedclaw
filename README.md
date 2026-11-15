# NakedClaw

OpenClaw, stripped to run 100+ agents on one Gateway.
OpenClaw re-checks and re-records things on every operation in case another process interferes. With a single Gateway and nothing else touching its state, that work only slows it down.

| Removed                                             | What it cost OpenClaw                         | Gain                       |
| --------------------------------------------------- | --------------------------------------------- | -------------------------- |
| Re-checking file ownership on every database access | ~23% of the Gateway's time                    | 72 → 12 ms per model call  |
| Limits that closed and reopened agent databases     | ~120 reopens a minute, agents refused at boot | none left                  |
| Rewriting auth usage after every model call         | over half of all database operations          | 5,632 → 21 writes a minute |
| Rebuilding session lists after every message        | ~2%                                           | rebuilt only when read     |
| Live streaming and session observing nobody watches | ~3–5%                                         | runs only with a viewer    |
| A 20 ms health-check timer                          | ~2%                                           | ~1%                        |

**Result** (same agents and plugins, burst of 48 agent runs at once, plugin code excluded): **37% less Gateway time per model call, 43% less CPU, 64% fewer database operations.**

**Only safe if:** one Gateway per state directory, nothing else edits its files, the state directory doesn't move while running, one API key per provider.

Details, what was kept and why, how to measure: [skill](.agents/skills/nakedclaw/SKILL.md).
