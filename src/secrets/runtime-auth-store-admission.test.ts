import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createAgentDatabaseInspectionRefusal,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

// NakedClaw: an agent database's admission refusal no longer isolates or degrades
// its own auth store; the snapshot holds only the shared store (assumption 7).
it.each(["unreadable", "other-owner", "pending-authority"])(
  "loads the shared store under a %s agent admission",
  async (scope) => {
    const root = tempDirs.make("openclaw-secret-admission-");
    const env = { OPENCLAW_STATE_DIR: root };
    const agentDir = path.join(root, "agents", "worker", "agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(databasePath, "fixture");
    const refusal =
      scope === "other-owner"
        ? {
            agentId: "worker",
            paths: [databasePath],
            code: "agent-database-ownership-mismatch" as const,
            embeddedOwnerId: "main",
            reason: "The worker path belongs to main.",
            repairHint: "Repair the worker database path.",
          }
        : createAgentDatabaseInspectionRefusal({
            agentId: "worker",
            paths: [databasePath],
            reason: "Inspection is still running.",
            pending: scope === "pending-authority",
          });
    recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
    const loadAuthStore = vi.fn(() =>
      loadAuthStoreWithProfiles({
        "custom:healthy": { type: "api_key", provider: "custom", key: "fixture-key" },
      }),
    );
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {},
      env,
      agentDirs: [agentDir],
      includeConfigRefs: false,
      allowUnavailableSecretOwners: true,
      loadAuthStore,
    });
    expect(snapshot.authStores.map((entry) => entry.agentDir)).toEqual([
      path.join(root, "agents", "main", "agent"),
    ]);
    expect(snapshot.authStores[0]?.store.profiles["custom:healthy"]).toMatchObject({
      key: "fixture-key",
    });
    expect(loadAuthStore).toHaveBeenCalledTimes(1);
    expect(loadAuthStore).toHaveBeenCalledWith(undefined);
    expect(snapshot.degradedOwners).toEqual([]);
    expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toBe(refusal);
  },
);
