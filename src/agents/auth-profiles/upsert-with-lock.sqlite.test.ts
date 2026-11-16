import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  closeAuthProfileReadPool,
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store-runtime.js";
import * as storeRuntime from "./store-runtime.js";
import type { ApiKeyCredential, OAuthCredential } from "./types.js";
import { persistAuthProfileBatch, upsertAuthProfileWithLock } from "./upsert-with-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stateDir of tempDirs.dirs) {
    closeAuthProfileReadPool({ kind: "root", rootPath: stateDir });
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearAuthProfileMigrationDiagnostics();
});

function apiKey(key: string): ApiKeyCredential {
  return { type: "api_key", provider: "openai", key };
}

function profile(profileId: string, key: string) {
  return { profileId, credential: apiKey(key) };
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const root = tempDirs.make("openclaw-auth-batch-");
  const agentDir = path.join(root, "agents", "work", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(agentDir));
}

/** Fails the shared store's state write, wherever the store lives. */
function rejectSharedAuthStateWrites(message: string): void {
  const stateDb = resolveSharedAuthStoreOwnership(process.env).location === "state-db";
  const database = new DatabaseSync(resolveSharedAuthStorePath(process.env));
  try {
    for (const event of ["INSERT", "UPDATE"]) {
      database.exec(
        stateDb
          ? `CREATE TRIGGER reject_auth_state_${event} BEFORE ${event} ON config_machine_state
             WHEN NEW.state_key = 'authProfiles.state'
             BEGIN SELECT RAISE(ABORT, '${message}'); END;`
          : `CREATE TRIGGER reject_auth_state_${event} BEFORE ${event} ON auth_profile_state
             BEGIN SELECT RAISE(ABORT, '${message}'); END;`,
      );
    }
  } finally {
    database.close();
  }
}

describe("auth profile batch persistence", () => {
  // NakedClaw: one shared store, so no separate local and shared owners, no
  // inherited or peer-agent authority, and no per-agent migration or schema
  // checks on writes (assumption 7; legacy migration is Doctor's).
  it.each([
    { initial: "missing", root: "selected" },
    { initial: "existing", root: "selected" },
    { initial: "missing", root: "changed" },
  ] as const)(
    "refuses a stale OAuth upsert after $initial authority changes during write admission ($root ambient root)",
    async ({ initial, root }) => {
      await withAgentDir(async (agentDir) => {
        const profileId = "openai:admission";
        const incoming: OAuthCredential = {
          type: "oauth",
          provider: "openai",
          access: "synthetic-old-access",
          refresh: "synthetic-old-refresh",
          expires: Date.now() + 60_000,
        };
        const authoritative: OAuthCredential = {
          ...incoming,
          access: "synthetic-new-access",
          refresh: "synthetic-new-refresh",
        };
        const ownerDir = agentDir;
        const selectedStateDir = path.resolve(agentDir, "../../..");
        const otherStateDir =
          root === "changed" ? tempDirs.make("auth-upsert-other-root-") : undefined;
        const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
        saveAuthProfileStore(
          { version: 1, profiles: initial === "existing" ? { [profileId]: incoming } : {} },
          ownerDir,
          saveOptions,
        );
        const release = createDeferredCore();
        const entered = createDeferredCore();
        const predecessor = runOpenClawAgentWriteAdmission(
          { agentId: "work", path: resolveAuthProfileDatabasePath(agentDir) },
          async () => {
            await release.promise;
            saveAuthProfileStore(
              { version: 1, profiles: { [profileId]: authoritative } },
              ownerDir,
              saveOptions,
            );
            if (otherStateDir) {
              process.env.OPENCLAW_STATE_DIR = otherStateDir;
            }
          },
        );
        const realUpdate = storeRuntime.updateAuthProfileStoreWithLock;
        vi.spyOn(storeRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) => {
          const updating = realUpdate(params);
          entered.resolve();
          return updating;
        });
        const upsert = upsertAuthProfileWithLock({ agentDir, profileId, credential: incoming });
        void upsert.catch(() => {});
        try {
          await Promise.race([entered.promise, upsert]);
        } finally {
          release.resolve();
          await Promise.allSettled([predecessor, upsert]);
          process.env.OPENCLAW_STATE_DIR = selectedStateDir;
        }
        await predecessor;
        await expect(upsert).resolves.toBeNull();
        expect(loadPersistedAuthProfileStore(ownerDir)?.profiles[profileId]).toEqual(authoritative);
      });
    },
  );

  it("does not restore a fenced OAuth refresh generation", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const credential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "single-use-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential;
      const fence = createOAuthRefreshFence({ profileId, credential });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);

      await expect(
        persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId, credential }],
        }),
      ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(fence);
    });
  });

  it("rejects pre-claim stale writes after the refresh fence settles", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const credential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "single-use-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential;
      const rotated = {
        ...credential,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
      const fence = createOAuthRefreshFence({ profileId, credential });

      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir);
      let queuedWrite: Promise<void> | undefined;
      await withOAuthProfileLock({ profileId, provider: credential.provider }, async () => {
        queuedWrite = persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId, credential }],
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        }).then(() => undefined);
        await updateAuthProfileStoreWithLock({
          agentDir,
          updater: (store) => {
            store.profiles[profileId] = fence;
            return true;
          },
        });
        await updateAuthProfileStoreWithLock({
          agentDir,
          updater: (store) => {
            store.profiles[profileId] = rotated;
            return true;
          },
        });
      });

      expect(queuedWrite).toBeDefined();
      await expect(queuedWrite!).rejects.toThrow(
        "Refused to restore fenced OAuth refresh generation",
      );
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(rotated);
    });
  });

  it("rejects stale nonportable OAuth batches admitted after a newer generation settles", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const consumed = {
        type: "oauth",
        provider: "openai",
        access: "consumed-access",
        refresh: "consumed-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential;
      const rotated = {
        ...consumed,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: rotated } }, agentDir);

      await expect(
        persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId, credential: consumed }],
        }),
      ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(rotated);
    });
  });

  it("does not resurrect a refresh fence during batch rollback", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const credential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "single-use-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential;
      const fence = createOAuthRefreshFence({ profileId, credential });
      const replacement = {
        ...credential,
        access: "login-access",
        refresh: "login-refresh",
        expires: Date.now() + 60_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);

      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId, credential: replacement }],
        order: { openai: [profileId] },
      });
      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: { [profileId]: replacement },
        order: { openai: [profileId] },
      });
    });
  });

  it("does not restore a nonportable OAuth generation during batch rollback", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const previous = {
        type: "oauth",
        provider: "openai",
        access: "previous-access",
        refresh: "previous-refresh",
        expires: Date.now() + 60_000,
      } satisfies OAuthCredential;
      const replacement = {
        ...previous,
        access: "replacement-access",
        refresh: "replacement-refresh",
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: previous } }, agentDir);

      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId, credential: replacement }],
        allowOAuthGenerationReplacement: true,
      });
      expect(receipt.rollback().unrevertedProfileIds).toEqual(new Set([profileId]));
      expect(receipt.rollback().unrevertedProfileIds).toEqual(new Set([profileId]));

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(replacement);
    });
  });

  it("allows portable copies and distinct generations to replace an OAuth fence", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:default";
      const credential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "single-use-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential;
      const fence = createOAuthRefreshFence({ profileId, credential });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);

      const portable = { ...credential, copyToAgents: true } satisfies OAuthCredential;
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId, credential: portable }],
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(portable);

      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir);
      const distinct = { ...credential, refresh: "distinct-refresh" } satisfies OAuthCredential;
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId, credential: distinct }],
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(distinct);
    });
  });

  it("conditionally rolls a portable profile batch and its order back to absence", async () => {
    await withAgentDir(async (agentDir) => {
      const noOp = await persistAuthProfileBatch({ agentDir, profiles: [] });
      noOp.rollback();
      expect(fs.existsSync(resolveAuthProfileDatabasePath(agentDir))).toBe(false);

      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [
          profile("openai:primary", " sk-primary "),
          {
            profileId: "openai:backup",
            credential: { type: "token", provider: "openai", token: " backup-token " },
          },
        ],
        order: { openai: ["openai:primary", "openai:backup"] },
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:primary": { key: "sk-primary" },
          "openai:backup": { token: "backup-token" },
        },
        order: { openai: ["openai:primary", "openai:backup"] },
      });

      receipt.rollback();
      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      expect(inspectPersistedAuthProfileStateRaw(agentDir).status).toBe("missing");
    });
  });

  it("removes only owned profiles and introduced order ids", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:existing": apiKey("sk-existing"),
          },
          order: { openai: ["openai:existing"] },
        },
        agentDir,
      );
      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [profile("openai:primary", "sk-attempt"), profile("openai:backup", "sk-backup")],
        order: { openai: ["openai:primary", "openai:backup"] },
      });
      await updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater: (store) => {
          store.profiles["openai:primary"] = apiKey("sk-newer");
          store.profiles["openai:concurrent"] = apiKey("sk-unrelated");
          store.order = {
            openai: ["openai:primary", "openai:backup", "openai:concurrent", "openai:existing"],
          };
          return true;
        },
      });

      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:primary": { key: "sk-newer" },
          "openai:existing": { key: "sk-existing" },
          "openai:concurrent": { key: "sk-unrelated" },
        },
        order: {
          openai: ["openai:primary", "openai:concurrent", "openai:existing"],
        },
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:backup"]).toBeUndefined();
    });
  });

  it("does not claim skipped non-replacing profiles or their order entries", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:existing": apiKey("sk-existing"),
            "openai:conflict": apiKey("sk-concurrent"),
          },
          order: { openai: ["openai:existing"] },
        },
        agentDir,
      );
      const receipt = await persistAuthProfileBatch({
        agentDir,
        profiles: [
          { ...profile("openai:conflict", "sk-portable"), replaceExisting: false },
          { ...profile("openai:portable", "sk-portable"), replaceExisting: false },
        ],
        order: { openai: ["openai:conflict", "openai:portable"] },
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:conflict": { key: "sk-concurrent" },
          "openai:portable": { key: "sk-portable" },
        },
        order: { openai: ["openai:existing", "openai:portable"] },
      });

      receipt.rollback();

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: {
          "openai:existing": { key: "sk-existing" },
          "openai:conflict": { key: "sk-concurrent" },
        },
        order: { openai: ["openai:existing"] },
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:portable"]).toBeUndefined();
    });
  });

  it("replaces one completed login and resets only its existing failure state", async () => {
    await withAgentDir(async (agentDir) => {
      const targetId = "openai:target";
      const siblingId = "openai:sibling";
      const targetLastUsed = Date.now() - 10_000;
      const targetLastFailureAt = Date.now() - 5_000;
      const targetLastProbeAt = Date.now() - 2_000;
      const siblingBlockedUntil = Date.now() + 120_000;
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [targetId]: apiKey("sk-stale"),
            [siblingId]: apiKey("sk-sibling"),
          },
          order: { openai: [siblingId, targetId] },
          lastGood: { openai: siblingId },
          usageStats: {
            [targetId]: {
              errorCount: 4,
              failureCounts: { auth_permanent: 4 },
              blockedUntil: Date.now() + 60_000,
              blockedReason: "subscription_limit",
              blockedSource: "wham",
              blockedModel: "gpt-5.6",
              blockedScope: "model",
              cooldownUntil: Date.now() + 60_000,
              cooldownReason: "auth_permanent",
              cooldownModel: "gpt-5.6",
              disabledUntil: Date.now() + 60_000,
              disabledReason: "auth_permanent",
              lastUsed: targetLastUsed,
              lastFailureAt: targetLastFailureAt,
              lastProbeAt: targetLastProbeAt,
            },
            [siblingId]: {
              errorCount: 2,
              blockedUntil: siblingBlockedUntil,
              blockedReason: "subscription_limit",
            },
          },
        },
        agentDir,
      );

      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: targetId, credential: apiKey("sk-fresh") }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: {
          [targetId]: apiKey("sk-fresh"),
          [siblingId]: apiKey("sk-sibling"),
        },
        order: { openai: [siblingId, targetId] },
        lastGood: { openai: siblingId },
        usageStats: {
          [targetId]: {
            errorCount: 0,
            lastUsed: targetLastUsed,
            lastFailureAt: targetLastFailureAt,
            lastProbeAt: targetLastProbeAt,
          },
          [siblingId]: {
            errorCount: 2,
            blockedUntil: siblingBlockedUntil,
            blockedReason: "subscription_limit",
          },
        },
      });
    });
  });

  it("rolls the completed-login credential and state back together on write failure", async () => {
    await withAgentDir(async (agentDir) => {
      const profileId = "openai:existing";
      const disabledUntil = Date.now() + 60_000;
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [profileId]: apiKey("sk-stale") },
          usageStats: {
            [profileId]: {
              errorCount: 3,
              disabledUntil,
              disabledReason: "auth_permanent",
            },
          },
        },
        agentDir,
      );
      rejectSharedAuthStateWrites("injected completed login state failure");

      await expect(
        persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId, credential: apiKey("sk-fresh") }],
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        }),
      ).rejects.toThrow("injected completed login state failure");

      expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: { [profileId]: apiKey("sk-stale") },
        usageStats: {
          [profileId]: {
            errorCount: 3,
            disabledUntil,
            disabledReason: "auth_permanent",
          },
        },
      });
    });
  });

  it("leaves no partial profile batch when the SQLite state write fails", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir);
      rejectSharedAuthStateWrites("injected auth batch state failure");

      await expect(
        persistAuthProfileBatch({
          agentDir,
          profiles: [profile("openai:first", "sk-first"), profile("openai:second", "sk-second")],
          order: { openai: ["openai:first", "openai:second"] },
        }),
      ).rejects.toThrow("injected auth batch state failure");

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles ?? {}).toEqual({});
    });
  });
});
