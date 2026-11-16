import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { authProfileRuntimeMode, resolveRuntimeAuthProfileAgentDir } from "./runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { inspectAgentAuthProfileJsonCellReadOnly } from "./sqlite-json.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  resolveAuthProfileStorePath,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";

// NakedClaw: every agent uses the shared credential store (assumption 7).
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawStateDatabaseForTest();
});

function makeStateDbWorld() {
  const stateDir = tempDirs.make("openclaw-shared-only-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
  writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
  const agentDir = path.join(stateDir, "agents", "aru", "agent");
  return { env, agentDir, sharedPath: resolveOpenClawStateSqlitePath(env) };
}

describe("shared-only credential stores", () => {
  it("routes an agent's store, runtime directory and snapshot read to the shared store", () => {
    const { env, agentDir, sharedPath } = makeStateDbWorld();
    expect(resolveRuntimeAuthProfileAgentDir(agentDir)).toBeUndefined();
    expect(resolveAuthProfileStorePath(agentDir, env)).toBe(sharedPath);
    // Ownership questions still name the agent's own database.
    expect(resolveAuthProfileDatabasePath(agentDir)).toBe(
      path.join(agentDir, "openclaw-agent.sqlite"),
    );
    // The secrets runtime publishes only the shared snapshot; an agent reads it.
    withEnv({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR: undefined }, () => {
      setRuntimeAuthProfileStoreSnapshot({
        version: 1,
        profiles: { "openai:shared": { type: "api_key", provider: "openai", key: "shared" } },
      });
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles).toHaveProperty(
        "openai:shared",
      );
    });
  });

  it("reads no agent database's auth rows", async () => {
    const { env, agentDir } = makeStateDbWorld();
    const leftover = {
      version: 1,
      profiles: { "openai:left": { type: "api_key" as const, provider: "openai", key: "left" } },
    };
    // Only a scoped run still reaches an agent's own database.
    authProfileRuntimeMode.run({ kind: "agent-dir", agentDir, env }, () =>
      writePersistedAuthProfileStoreRaw(leftover, agentDir),
    );
    expect(
      inspectAgentAuthProfileJsonCellReadOnly(resolveAuthProfileDatabasePath(agentDir), "store"),
    ).toMatchObject({ status: "readable" });
    const reader = prepareAgentAuthProfileRowsRead({
      databasePath: resolveAuthProfileDatabasePath(agentDir),
      agentId: "aru",
      env,
    });
    await expect(reader.read()).resolves.toMatchObject({
      store: { status: "missing" },
      state: { status: "missing" },
    });
    await reader.dispose();
  });

  it("keeps a scoped run on its own directory", () => {
    const { env, agentDir } = makeStateDbWorld();
    authProfileRuntimeMode.run({ kind: "agent-dir", agentDir, env }, () => {
      expect(resolveRuntimeAuthProfileAgentDir()).toBe(agentDir);
      expect(resolveAuthProfileStorePath(agentDir, env)).toBe(
        path.join(agentDir, "openclaw-agent.sqlite"),
      );
    });
  });
});
