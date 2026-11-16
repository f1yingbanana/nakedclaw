/**
 * Tests auth profile mutation helpers.
 * Covers locked upserts, order promotion, last-good clearing, legacy OAuth file
 * imports, and credential normalization.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential, oauthCred } from "./credential-fixtures.test-support.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./mutation-lineage.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { reloadSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  expectOAuthCredentialFields,
  failNextRuntimeAuthSnapshotPublication,
  withAuthProfileTestState,
} from "./profile-mutations.test-support.js";
import {
  clearLastGoodProfileWithLock,
  markAuthProfileSuccess,
  promoteAuthProfileInOrder,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  setAuthProfileOrder,
  upsertAuthProfileWithLock,
} from "./profiles.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore as getInternalRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreCredentialsRevision,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import { runAuthProfileWriteTransaction, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  saveAuthProfileStore,
} from "./store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  getRuntimeAuthProfileStoreSnapshot,
  restoreAuthProfileStorePersistenceSnapshot,
} from "./store.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

vi.mock("../provider-auth-aliases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-auth-aliases.js")>();
  return {
    ...actual,
    resolveProviderIdForAuth: (...args: Parameters<typeof actual.resolveProviderIdForAuth>) => {
      const provider = args[0].trim().toLowerCase();
      return provider === "gmi-cloud" || provider === "gmicloud"
        ? "gmi"
        : actual.resolveProviderIdForAuth(...args);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("promoteAuthProfileInOrder", () => {
  it("refreshes inherited main selection state without advancing credential ownership", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-main-selection-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        const mainStore = (selected: string): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:first": createApiKeyCredential("openai", "sk-first"),
            "openai:second": createApiKeyCredential("openai", "sk-second"),
          },
          order: { openai: [selected] },
        });
        saveAuthProfileStore(mainStore("openai:first"));
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: customAgentDir,
            store: loadAuthProfileStoreForRuntime(customAgentDir),
          },
        ]);
        const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();

        saveAuthProfileStore(mainStore("openai:second"));

        expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialsRevision);
        expect(getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.order?.openai).toEqual([
          "openai:second",
        ]);
      },
      { clearOAuthDir: true },
    );
  });

  // NakedClaw: removed the tests of derived custom-agent snapshots (rebuild after a
  // main rotation, inherited resolved credentials, publication failure isolated
  // to one agent's store, unreadable derived owners); every agent reads the
  // shared store (assumption 7).

  it("keeps a direct save committed when postcommit publication throws", async () => {
    await withAuthProfileTestState("openclaw-auth-direct-publication-", async ({ agentDir }) => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
        },
      });
      saveAuthProfileStore(store("sk-old"), agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      failNextRuntimeAuthSnapshotPublication();
      expect(saveAuthProfileStore(store("sk-new"), agentDir)).toBeUndefined();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    });
  });

  // NakedClaw: the caller's transaction holds the shared store (assumption 7).
  it("publishes a caller-owned database transaction from the supplied store", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-transaction-", async () => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
          "openai:backup": { type: "api_key", provider: "openai", key: "sk-backup" },
        },
        order: {
          openai:
            key === "sk-old"
              ? ["openai:default", "openai:backup"]
              : ["openai:backup", "openai:default"],
        },
      });
      saveAuthProfileStore(store("sk-old"));
      replaceRuntimeAuthProfileStoreSnapshots([{ store: loadAuthProfileStoreForRuntime() }]);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialMutationToken().revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken().revision;

      runAuthProfileWriteTransaction(undefined, (database) => {
        saveAuthProfileStore(store("sk-new"), undefined, undefined, database);
      });

      expect(loadPersistedAuthProfileStore()?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(getRuntimeAuthProfileStoreSnapshot()?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(getRuntimeAuthProfileStoreSnapshot()?.order?.openai).toEqual([
        "openai:backup",
        "openai:default",
      ]);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken().revision).toBeGreaterThan(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationToken().revision).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  // NakedClaw: removed the test of derived agent snapshots kept through a main-store
  // no-op; agents have no snapshots of their own (assumption 7).

  it("drops caller-owned publication when a nested savepoint rolls back", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-savepoint-", async ({ agentDir }) => {
      const initial: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-initial" },
        },
      };
      const candidate: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-candidate" },
        },
      };
      saveAuthProfileStore(initial, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);

      runAuthProfileWriteTransaction(agentDir, () => {
        expect(() =>
          runAuthProfileWriteTransaction(agentDir, (database) => {
            saveAuthProfileStore(candidate, agentDir, undefined, database);
            throw new Error("rollback savepoint");
          }),
        ).toThrow("rollback savepoint");
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(initial);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
    });
  });

  // NakedClaw: the agent's save lands in the shared store in the state database
  // (assumption 7), so the failing state write is that store's state row.
  it("rolls back credentials when the state write fails", async () => {
    await withAuthProfileTestState("openclaw-auth-atomic-save-", async ({ agentDir }) => {
      const oldStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:old": { type: "api_key", provider: "openai", key: "sk-old" },
        },
        order: { openai: ["openai:old"] },
      };
      saveAuthProfileStore(oldStore, agentDir);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialMutationToken().revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken().revision;
      const database = openOpenClawStateDatabase();
      database.db.exec(`
        CREATE TRIGGER reject_auth_profile_state_update
        BEFORE UPDATE ON config_machine_state
        WHEN NEW.state_key = 'authProfiles.state'
        BEGIN
          SELECT RAISE(ABORT, 'injected auth state write failure');
        END;
      `);

      expect(() =>
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:new": { type: "api_key", provider: "openai", key: "sk-new" },
            },
            order: { openai: ["openai:new"] },
          },
          agentDir,
        ),
      ).toThrow("injected auth state write failure");
      database.db.exec("DROP TRIGGER reject_auth_profile_state_update;");

      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir)).toMatchObject(oldStore);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken().revision).toBe(credentialRevision);
      expect(getRuntimeAuthProfileStoreStateMutationToken().revision).toBe(stateRevision);
    });
  });

  it("restores materialized and runtime-external snapshot credentials after a temporary write", async () => {
    await withAuthProfileTestState("openclaw-auth-runtime-restore-", async ({ agentDir }) => {
      const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-materialized",
              keyRef,
            },
          },
        },
        agentDir,
      );
      const runtimeStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-materialized",
            keyRef,
          },
          "anthropic:external": oauthCred({
            provider: "anthropic",
            access: "external-access",
            refresh: "external-refresh",
            expires: Date.now() + 60_000,
          }),
        },
        runtimeExternalProfileIds: ["anthropic:external"],
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: runtimeStore }]);
      const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot,
        agentDir,
        store: {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:temporary": createApiKeyCredential("openai", "sk-temporary"),
          },
        },
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      const { owned } = committed;
      restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toMatchObject(runtimeStore);
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
      ).toBeUndefined();
    });
  });

  it("does not persist built-in CLI ownership metadata", async () => {
    await withAuthProfileTestState("openclaw-auth-cli-provenance-", async ({ agentDir }) => {
      const profileId = "openai:default";
      const runtimeStore: RuntimeAuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [profileId]: oauthCred({
            provider: "openai",
            access: "external-access",
            refresh: "external-refresh",
            expires: Date.now() + 60_000,
          }),
        },
        runtimeExternalProfileIds: [profileId],
        runtimeExternalCliProfileIds: [profileId],
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: runtimeStore }]);

      saveAuthProfileStore(runtimeStore, agentDir);

      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted).not.toHaveProperty("runtimeExternalCliProfileIds");
      expect(persisted?.profiles[profileId]).toBeUndefined();
    });
  });

  it.each(["before save", "before publication"] as const)(
    "preserves a runtime-only OAuth mutation %s",
    async (mutationTiming) => {
      await withAuthProfileTestState(
        "openclaw-auth-runtime-edge-ownership-",
        async ({ agentDir }) => {
          const baselineStore: AuthProfileStore = {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:baseline": createApiKeyCredential("openai", "sk-baseline"),
              "anthropic:external": oauthCred({
                provider: "anthropic",
                access: "external-before-capture",
                refresh: "external-refresh",
                expires: Date.now() + 60_000,
              }),
            },
            runtimeExternalProfileIds: ["anthropic:external"],
          };
          saveAuthProfileStore(baselineStore, agentDir);
          replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: baselineStore }]);
          const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

          const mutateRuntimeStore = () => {
            replaceRuntimeAuthProfileStoreSnapshots([
              {
                agentDir,
                store: {
                  ...baselineStore,
                  profiles: {
                    ...baselineStore.profiles,
                    "anthropic:external": oauthCred({
                      provider: "anthropic",
                      access: "external-after-capture",
                      refresh: "external-refresh-new",
                      expires: Date.now() + 120_000,
                    }),
                  },
                },
              },
            ]);
          };
          if (mutationTiming === "before save") {
            mutateRuntimeStore();
          }
          const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
            snapshot,
            agentDir,
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:temporary": createApiKeyCredential("openai", "sk-temporary"),
              },
            },
          });
          if (mutationTiming === "before publication") {
            mutateRuntimeStore();
          }
          expect(committed.publishRuntimeSnapshots()).toBe(true);
          const { owned } = committed;

          restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

          expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles).toMatchObject({
            "openai:baseline": { key: "sk-baseline" },
            "anthropic:external": {
              access: "external-after-capture",
              refresh: "external-refresh-new",
            },
          });
          expect(
            getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
          ).toBeUndefined();
        },
        { clearOAuthDir: true },
      );
    },
  );

  // NakedClaw: the captured snapshot's restore is the test above; agents share it (assumption 7).
  it("rebuilds a newer runtime snapshot after a rollback", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-main-newer-rollback-",
      async ({ agentDir }) => {
        const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:baseline": {
              type: "api_key",
              provider: "openai",
              keyRef,
            },
          },
        });
        const snapshot = captureAuthProfileStorePersistenceSnapshot();

        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          snapshot,
          store: {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:temporary": createApiKeyCredential("openai", "sk-temporary"),
            },
          },
        });
        expect(committed.publishRuntimeSnapshots()).toBe(true);
        const newerRuntime = loadAuthProfileStoreForRuntime(agentDir);
        newerRuntime.profiles["anthropic:newer-external"] = oauthCred({
          provider: "anthropic",
          access: "newer-external-access",
          refresh: "newer-external-refresh",
          expires: Date.now() + 60_000,
        });
        newerRuntime.runtimeExternalProfileIds = ["anthropic:newer-external"];
        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: newerRuntime }]);

        restoreAuthProfileStorePersistenceSnapshot(snapshot, committed.owned);

        expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles).toMatchObject({
          "openai:baseline": { keyRef },
          "anthropic:newer-external": { access: "newer-external-access" },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
        ).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("restores an exactly owned derived snapshot under its custom database key", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-custom-key-rollback-",
      async ({ agentDirFor }) => {
        const derivedAgentDir = agentDirFor("custom-key");
        const databasePath = path.join(derivedAgentDir, "custom.sqlite");
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:baseline": createApiKeyCredential("openai", "sk-baseline"),
          },
        });
        const capturedRuntime = loadAuthProfileStoreForRuntime(derivedAgentDir);
        replaceRuntimeAuthProfileStoreSnapshots([
          { databasePath, agentDir: derivedAgentDir, store: capturedRuntime },
        ]);
        const snapshot = captureAuthProfileStorePersistenceSnapshot();
        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          snapshot,
          store: {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:temporary": createApiKeyCredential("openai", "sk-temporary"),
            },
          },
        });

        expect(committed.publishRuntimeSnapshots()).toBe(true);
        expect(listOwnedRuntimeAuthProfileStoreSnapshots()).toEqual([
          expect.objectContaining({
            databasePath,
            store: expect.objectContaining({
              profiles: expect.objectContaining({
                "openai:temporary": expect.objectContaining({ key: "sk-temporary" }),
              }),
            }),
          }),
        ]);

        restoreAuthProfileStorePersistenceSnapshot(snapshot, committed.owned);

        expect(listOwnedRuntimeAuthProfileStoreSnapshots()).toEqual([
          expect.objectContaining({
            databasePath,
            store: expect.objectContaining({
              profiles: expect.objectContaining({
                "openai:baseline": expect.objectContaining({ key: "sk-baseline" }),
              }),
            }),
          }),
        ]);
      },
    );
  });

  it("tracks state-only saves without advancing credential ownership", async () => {
    await withAuthProfileTestState("openclaw-auth-state-lineage-", async ({ agentDir }) => {
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-stable" },
        },
      };
      saveAuthProfileStore(store, agentDir);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialsRevision();
      // The agent's saves land in the shared store (assumption 7).
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken().revision;

      saveAuthProfileStore(
        { ...store, usageStats: { "openai:default": { lastUsed: 42 } } },
        agentDir,
      );

      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialRevision);
      expect(getRuntimeAuthProfileStoreStateMutationToken().revision).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  it("marks newly saved runtime snapshot profiles as persisted", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-runtime-persisted-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        // The agent's runtime snapshot is the shared one (assumption 7); create that
        // store first so the snapshot is keyed where the save lands.
        saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles: {} });
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {},
            },
          },
        ]);
        try {
          saveAuthProfileStore(
            {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:work": {
                  type: "oauth",
                  provider: "openai",
                  access: "access-token",
                  refresh: "refresh-token",
                  expires: Date.now() + 60_000,
                  accountId: "account-123",
                },
              },
            },
            agentDir,
          );

          expect(getRuntimeAuthProfileStoreSnapshot()?.runtimePersistedProfileIds).toEqual([
            "openai:work",
          ]);
          expect(getInternalRuntimeAuthProfileStoreSnapshot()?.runtimeLocalProfileIds).toEqual([
            "openai:work",
          ]);
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
      { clearOAuthDir: true },
    );
  });

  it("normalizes copied secrets when using the locked upsert path", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-upsert-",
      async ({ agentDirFor }) => {
        const agentDir = agentDirFor("work");
        fs.mkdirSync(agentDir, { recursive: true });

        await upsertAuthProfileWithLock({
          profileId: "openai:manual",
          credential: {
            type: "token",
            provider: "openai",
            token: "  bearer\r\n-token\u2502  ",
          },
          agentDir,
        });
        await upsertAuthProfileWithLock({
          profileId: "anthropic:key",
          credential: createApiKeyCredential("anthropic", "  sk-\r\nant\u2502  "),
          agentDir,
        });

        const store = loadAuthProfileStoreWithoutExternalProfiles(
          agentDir,
        ) as RuntimeAuthProfileStore;
        expect(store.runtimePersistedProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeLocalProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeExternalProfileIds).toBeUndefined();
        expect(store.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
        const profiles = store.profiles;
        expect(profiles["openai:manual"]).toMatchObject({
          type: "token",
          provider: "openai",
          token: "bearer-token",
        });
        expect(profiles["anthropic:key"]).toMatchObject({
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("persists openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-metadata-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];

      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "local-access-token",
        refresh: "local-refresh-token",
        idToken: "local-id-token",
        expires,
        email: "dev@example.test",
        accountId: "acct-local",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(path.join(resolveOAuthDir(), "auth-profiles"))).toBe(false);

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    });
  });

  it("preserves access-only openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-access-only-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "access-only-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "access-only-token",
        },
      );
    });
  });

  // NakedClaw: removed the test of an OAuth profile copied into another agent's
  // store; agents have no stores of their own (assumption 7).

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-promote-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:bunsthedev@gmail.com";
      const staleProfileId = "openai:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: oauthCred({
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            }),
            [staleProfileId]: oauthCred({
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            }),
          },
          order: {
            openai: [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
      });

      expect(updated).toMatchObject({
        ok: true,
        value: { order: { openai: [newProfileId, staleProfileId] } },
      });
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    });
  });

  it("creates a per-agent provider order when relogin has no existing order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-create-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const primaryProfileId = "openai:primary-login";
      const backupProfileId = "openai:backup-login";
      const unrelatedProfileId = "openai:unrelated-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [primaryProfileId]: oauthCred({
              provider: "openai",
              access: "primary-access",
              refresh: "primary-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            }),
            [backupProfileId]: oauthCred({
              provider: "openai",
              access: "backup-access",
              refresh: "backup-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            }),
            [newProfileId]: oauthCred({
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            }),
            [unrelatedProfileId]: oauthCred({
              provider: "openai",
              access: "unrelated-access",
              refresh: "unrelated-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            }),
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [backupProfileId, primaryProfileId],
      });

      expect(updated).toMatchObject({
        ok: true,
        value: { order: { openai: [newProfileId, backupProfileId, primaryProfileId] } },
      });
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        backupProfileId,
        primaryProfileId,
      ]);
    });
  });

  it("preserves config-only fallback ids when creating a relogin order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-config-only-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const existingProfileId = "openai:old-login";
      const configOnlyProfileId = "openai:aws-sdk";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [existingProfileId]: oauthCred({
              provider: "openai",
              access: "old-access",
              refresh: "old-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            }),
            [newProfileId]: oauthCred({
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            }),
          },
        },
        agentDir,
      );

      await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [existingProfileId, configOnlyProfileId],
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
      saveAuthProfileStore(loadAuthProfileStoreForRuntime(agentDir), agentDir);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
    });
  });

  it("keeps implicit round-robin when relogin has no existing order by default", async () => {
    await withAuthProfileTestState("openclaw-auth-order-implicit-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: oauthCred({
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            }),
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
      });

      expect(updated).toMatchObject({ ok: true });
      expect(updated.ok && updated.value.order?.["openai"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toBeUndefined();
    });
  });

  it("clears matching lastGood after a stale refresh_token_reused profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: oauthCred({
              provider: "openai",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            }),
          },
          lastGood: { openai: staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: staleProfileId,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    });
  });

  it("clears cooldown classification and retry backoff after a successful profile use", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-success-classification-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        const profileId = "openai:default";
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: { type: "api_key", provider: "openai", key: "sk-test" },
            },
            usageStats: {
              [profileId]: {
                cooldownUntil: Date.now() + 60_000,
                cooldownReason: "rate_limit",
                cooldownClassification: "wham_token_expired",
                errorCount: 12,
                failureCounts: { rate_limit: 12 },
              },
            },
          },
          agentDir,
        );
        const store = loadAuthProfileStoreForRuntime(agentDir);

        await markAuthProfileSuccess({ store, provider: "openai", profileId, agentDir });

        expect(store.usageStats?.[profileId]).toMatchObject({ errorCount: 0 });
        expect(store.usageStats?.[profileId]?.failureCounts).toBeUndefined();
        expect(store.usageStats?.[profileId]?.cooldownUntil).toBeUndefined();
        const persistedStats = loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId];
        expect(persistedStats).toMatchObject({ errorCount: 0 });
        expect(persistedStats).not.toHaveProperty("failureCounts");
        expect(persistedStats).not.toHaveProperty("cooldownUntil");
        expect(persistedStats).not.toHaveProperty("cooldownClassification");
      },
    );
  });

  it.each(
    (["main", "secondary", "shared"] as const).flatMap((scope) =>
      [false, true].map((selected) => ({ scope, selected })),
    ),
  )(
    "clears the shared credential owner from a $scope removal before replacing an expired login (selected=$selected)",
    async ({ scope, selected }) => {
      await withAuthProfileTestState("openclaw-auth-force-owner-", async ({ agentDirFor }) => {
        const profileId = "openai:default";
        const expired = {
          type: "token" as const,
          provider: "openai",
          token: "synthetic-expired",
          expires: 1,
        };
        const retainedId = "openai:retained";
        const unrelated = { type: "api_key" as const, provider: "other", key: "synthetic-other" };
        // NakedClaw: every agent's removal clears the one shared store (assumption 7).
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: expired, [retainedId]: expired, "other:default": unrelated },
          order: { openai: [profileId, retainedId] },
          lastGood: { openai: profileId },
          usageStats: { [profileId]: { disabledUntil: Date.now() + 60_000 } },
        });
        const selectedDir = scope === "shared" ? undefined : agentDirFor(scope);

        expect(
          await removeProviderAuthProfilesWithLock({
            provider: "openai",
            agentDir: selectedDir,
            ...(selected ? { profileIds: [profileId] } : {}),
          }),
        ).not.toBeNull();

        const stored = loadPersistedAuthProfileStore();
        expect(stored?.profiles[profileId]).toBeUndefined();
        expect(stored?.profiles[retainedId]).toEqual(selected ? expired : undefined);
        expect(stored?.profiles["other:default"]).toEqual(unrelated);
        expect(stored?.order?.openai).toEqual(selected ? [retainedId] : undefined);
        expect(stored?.lastGood?.openai).toBeUndefined();
        expect(stored?.usageStats?.[profileId]).toBeUndefined();
        const fresh = { ...expired, token: "synthetic-fresh", expires: Date.now() + 60_000 };
        await persistAuthProfileBatch({
          agentDir: selectedDir,
          profiles: [{ profileId, credential: fresh }],
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        expect(loadAuthProfileStoreForRuntime(selectedDir).profiles[profileId]).toEqual(fresh);
      });
    },
  );

  it("narrows provider removal to selected profiles", async () => {
    await withAuthProfileTestState("openclaw-auth-remove-selected-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const initialStore: RuntimeAuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openrouter:oauth": oauthCred({
            provider: "openrouter",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          }),
          "openrouter:api-key": createApiKeyCredential("openrouter", "api-key"),
        },
        order: { openrouter: ["openrouter:oauth", "openrouter:api-key"] },
        lastGood: { openrouter: "openrouter:oauth" },
        usageStats: {
          "openrouter:oauth": { lastUsed: 1 },
          "openrouter:api-key": { lastUsed: 2 },
        },
        runtimePersistedProfileIds: ["openrouter:oauth", "openrouter:api-key"],
        runtimeLocalProfileIds: ["openrouter:oauth", "openrouter:api-key"],
        runtimeExternalProfileIds: ["openrouter:oauth", "openrouter:api-key"],
        runtimeExternalCliProfileIds: ["openrouter:oauth", "openrouter:api-key"],
      };
      saveAuthProfileStore(initialStore, agentDir);

      const removedStore: RuntimeAuthProfileStore | null = await removeProviderAuthProfilesWithLock(
        {
          agentDir,
          provider: "openrouter",
          profileIds: ["openrouter:oauth"],
        },
      );

      expect(loadAuthProfileStoreForRuntime(agentDir)).toMatchObject({
        profiles: { "openrouter:api-key": expect.any(Object) },
        order: { openrouter: ["openrouter:api-key"] },
        usageStats: { "openrouter:api-key": { lastUsed: 2 } },
      });
      expect(loadAuthProfileStoreForRuntime(agentDir).profiles["openrouter:oauth"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
      expect(removedStore?.runtimePersistedProfileIds ?? []).not.toContain("openrouter:oauth");
      expect(removedStore?.runtimeLocalProfileIds ?? []).not.toContain("openrouter:oauth");
      expect(removedStore?.runtimeExternalProfileIds ?? []).not.toContain("openrouter:oauth");
      expect(removedStore ? getRuntimeExternalCliProfileIds(removedStore) : []).not.toContain(
        "openrouter:oauth",
      );
    });
  });

  it("does not materialize credentials while force-clearing a fresh main store", async () => {
    await withAuthProfileTestState("openclaw-auth-force-fresh-", async ({ agentDir }) => {
      await removeProviderAuthProfilesWithLock({ provider: "openai", agentDir });
      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();

      const credential = { type: "token" as const, provider: "openai", token: "synthetic-fresh" };
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: "openai:default", credential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      // The agent's login lands in the shared store (assumption 7).
      expect(loadPersistedAuthProfileStore()?.profiles["openai:default"]).toEqual(credential);
    });
  });

  it("does not rewrite the store when selected profiles are absent", async () => {
    await withAuthProfileTestState("openclaw-auth-remove-noop-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const initialStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openrouter:api-key": createApiKeyCredential("openrouter", "api-key"),
        },
      };
      saveAuthProfileStore(initialStore, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      const credentialRevision =
        getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;

      await removeProviderAuthProfilesWithLock({
        agentDir,
        provider: "openrouter",
        profileIds: ["openrouter:missing"],
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toEqual(initialStore);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision).toBe(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision).toBe(stateRevision);
    });
  });

  it.each(
    (["profile", "provider"] as const).flatMap((scope) =>
      [false, true].map((replaceDuringCleanup) => ({ scope, replaceDuringCleanup })),
    ),
  )(
    "removes a legacy-main $scope once after config cleanup (replacement=$replaceDuringCleanup)",
    async ({ scope, replaceDuringCleanup }) => {
      await withAuthProfileTestState("openclaw-auth-remove-shared-alias-", async ({ agentDir }) => {
        const profileId = "openai:default";
        const original = {
          type: "token" as const,
          provider: "openai",
          token: "synthetic-original",
        };
        const replacement = { ...original, token: "synthetic-replacement" };
        const unrelated = createApiKeyCredential("other", "synthetic-other");
        const store = {
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: original, "other:default": unrelated },
        };
        // Rows already in the main agent database keep this world legacy-main; a
        // fresh shared write would otherwise move the store to the state database.
        runAuthProfileWriteTransaction(agentDir, (database) =>
          writePersistedAuthProfileStoreRaw(store, agentDir, database),
        );
        saveAuthProfileStore(store, agentDir);
        expect(reloadSharedAuthStoreOwnership().location).toBe("legacy-main");
        const beforeRemove = vi.fn(async () => {
          expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(original);
          if (replaceDuringCleanup) {
            saveAuthProfileStore(
              { ...store, profiles: { ...store.profiles, [profileId]: replacement } },
              agentDir,
            );
          }
        });
        const onIncomplete = vi.fn(async () => {});

        const removed = await removeAuthProfilesAcrossOwnerStores({
          agentDir,
          profileIds: [profileId],
          ...(scope === "provider" ? { provider: "openai" } : {}),
          beforeRemove,
          onIncomplete,
        });

        expect(removed).toBe(!replaceDuringCleanup);
        expect(beforeRemove).toHaveBeenCalledExactlyOnceWith([profileId], expect.any(Array));
        for (const owner of [agentDir, undefined]) {
          const persisted = loadPersistedAuthProfileStore(owner);
          expect(persisted?.profiles[profileId]).toEqual(
            replaceDuringCleanup ? replacement : undefined,
          );
          expect(persisted?.profiles["other:default"]).toEqual(unrelated);
        }
        if (replaceDuringCleanup) {
          expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
            new Map([[profileId, replacement]]),
            expect.any(Array),
          );
        } else {
          expect(onIncomplete).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("removes an inherited profile from the owning main store too", async () => {
    await withAuthProfileTestState("openclaw-auth-remove-owner-", async ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const customAgentDir = agentDirFor("custom");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(customAgentDir, { recursive: true });
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        access: "inherited-access",
        refresh: "inherited-refresh",
        expires: Date.now() + 60_000,
      };
      saveAuthProfileStore(
        { version: AUTH_STORE_VERSION, profiles: { "openai:shared": credential } },
        mainAgentDir,
      );
      saveAuthProfileStore(
        { version: AUTH_STORE_VERSION, profiles: { "openai:shared": credential } },
        customAgentDir,
      );

      const removed = await removeAuthProfilesAcrossOwnerStores({
        agentDir: customAgentDir,
        profileIds: ["openai:shared"],
      });

      expect(removed).toBe(true);
      expect(
        loadAuthProfileStoreForRuntime(customAgentDir).profiles["openai:shared"],
      ).toBeUndefined();
      expect(
        loadAuthProfileStoreForRuntime(mainAgentDir).profiles["openai:shared"],
      ).toBeUndefined();
    });
  });

  it("retries removal when the OAuth generation changes while waiting for its lock", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-remove-generation-race-",
      async ({ agentDirFor }) => {
        const mainAgentDir = agentDirFor("main");
        const peerAgentDir = agentDirFor("peer");
        const profileId = "openai:default";
        const original = {
          type: "oauth" as const,
          provider: "openai",
          access: "original-access",
          refresh: "original-refresh",
          expires: Date.now() + 60_000,
        };
        const replacement = {
          ...original,
          access: "replacement-access",
          refresh: "replacement-refresh",
        };
        saveAuthProfileStore(
          { version: AUTH_STORE_VERSION, profiles: { [profileId]: original } },
          mainAgentDir,
        );
        saveAuthProfileStore(
          { version: AUTH_STORE_VERSION, profiles: { [profileId]: original } },
          peerAgentDir,
        );

        let releaseLock: (() => void) | undefined;
        let markLocked: (() => void) | undefined;
        const locked = new Promise<void>((resolve) => {
          markLocked = resolve;
        });
        const blocker = withOAuthProfileLock({ profileId, provider: "openai" }, async () => {
          markLocked?.();
          await new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        });
        await locked;

        const removing = removeAuthProfilesAcrossOwnerStores({
          agentDir: mainAgentDir,
          profileIds: [profileId],
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        saveAuthProfileStore(
          { version: AUTH_STORE_VERSION, profiles: { [profileId]: replacement } },
          mainAgentDir,
        );
        saveAuthProfileStore(
          { version: AUTH_STORE_VERSION, profiles: { [profileId]: replacement } },
          peerAgentDir,
        );
        releaseLock?.();
        await blocker;

        await expect(removing).resolves.toBe(true);
        expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toBeUndefined();
        expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toBeUndefined();
      },
    );
  });

  it("does not clear lastGood when the failed profile is not the stored profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-keep-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const goodProfileId = "openai:user@example.test";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: oauthCred({
              provider: "openai",
              access: "good-access-token",
              refresh: "good-refresh-token",
              expires: Date.now() + 60_000,
            }),
          },
          lastGood: { openai: goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: "openai:default",
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai"]).toBe(goodProfileId);
    });
  });
});

describe("setAuthProfileOrder", () => {
  it("writes an explicit main-agent order to the canonical shared store", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-order-set-shared-main-",
      async ({ agentDir }) => {
        writeConfigMachineState(
          SHARED_AUTH_STORE_STATE_KEY,
          { location: "state-db" },
          { env: process.env },
        );
        reloadSharedAuthStoreOwnership(process.env);
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:first": oauthCred({
              provider: "openai",
              access: "first",
              refresh: "first-refresh",
              expires: Date.now() + 60_000,
            }),
            "openai:second": oauthCred({
              provider: "openai",
              access: "second",
              refresh: "second-refresh",
              expires: Date.now() + 60_000,
            }),
          },
          order: { openai: ["openai:first", "openai:second"] },
        });

        await setAuthProfileOrder({
          agentDir,
          provider: "openai",
          order: ["openai:second", "openai:first"],
          sharedStoreWrite: true,
        });

        expect(loadPersistedAuthProfileStore()?.order?.openai).toEqual([
          "openai:second",
          "openai:first",
        ]);
      },
      { clearOAuthDir: true },
    );
  });

  it("canonicalizes every alias-equivalent provider state mutation", async () => {
    await withAuthProfileTestState("openclaw-auth-alias-state-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const primary = "gmi:primary";
      const secondary = "gmi:secondary";
      const profiles = {
        [primary]: { type: "api_key" as const, provider: "gmi", key: "primary" },
        [secondary]: { type: "api_key" as const, provider: "gmi", key: "secondary" },
        "openai:other": { type: "api_key" as const, provider: "openai", key: "other" },
      };
      const seeded = (): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles,
        order: {
          "gmi-cloud": [primary],
          openai: ["openai:other"],
          gmicloud: [secondary],
        },
        lastGood: { gmicloud: secondary, openai: "openai:other", "gmi-cloud": primary },
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: [secondary] });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary],
      });
      saveAuthProfileStore(
        {
          ...seeded(),
          order: { ...seeded().order, gmi: [primary] },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();
      await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: null });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
      });

      saveAuthProfileStore(
        {
          ...seeded(),
          order: { ...seeded().order, "gmi-cloud": [secondary, primary] },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshots();
      await promoteAuthProfileInOrder({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
        openai: ["openai:other"],
        gmi: [secondary, primary],
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await clearLastGoodProfileWithLock({ agentDir, provider: "gmi-cloud", profileId: secondary });
      expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual({
        openai: "openai:other",
      });

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      const runtimeStore = loadAuthProfileStoreForRuntime(agentDir);
      await markAuthProfileSuccess({
        agentDir,
        profileId: secondary,
        provider: "gmi-cloud",
        store: runtimeStore,
      });
      // NakedClaw: a clean profile's success writes no lastGood (nakedclaw skill, assumption 5).
      expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual(seeded().lastGood);

      saveAuthProfileStore(seeded(), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      await removeProviderAuthProfilesWithLock({ agentDir, provider: "gmi-cloud" });
      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
        profiles: { "openai:other": expect.any(Object) },
        order: { openai: ["openai:other"] },
        lastGood: { openai: "openai:other" },
      });
    });
  });

  // NakedClaw: removed the test of a secondary agent's own order over inherited
  // profiles; every agent's order is the shared store's (assumption 7).

  it("clears a provider order without preserving any profile IDs", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-order-set-clear-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:local": createApiKeyCredential("openai", "sk-local"),
          },
          order: { openai: ["openai:local"] },
        });

        const updated = await setAuthProfileOrder({
          agentDir,
          provider: "openai",
          order: null,
        });

        expect(updated?.order?.openai ?? null).toBeNull();
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.openai ?? null).toBeNull();
      },
      { clearOAuthDir: true },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
