import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "../../secrets/runtime-fast-path.js";
import { activateSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import {
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import {
  assertAuthProfileMigrationReady,
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./mutation-lineage.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { authProfileRuntimeMode } from "./runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import {
  resolveAuthProfileDatabasePath,
  resolveAuthProfileStorePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { authProfileScopeCwdEntrypoint } from "./store-scope-cwd-runtime.test-support.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  restoreAuthProfileStorePersistenceSnapshot,
  withAuthProfileStoreAgentDir,
} from "./store.js";
import type { AuthProfileCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

describe("auth publication owner receipts", () => {
  it.each(["cold", "cached", "activated", "admitted"] as const)(
    "observes the exact shared credential owner through a %s read",
    async (mode) => {
      const owner = await seedRoot("observed");
      if (mode === "cold") {
        clearRuntimeAuthProfileStoreSnapshots();
      } else if (mode === "activated") {
        withEnv(owner.env, () => {
          const prepared = prepareSecretsRuntimeFastPathSnapshot({
            config: {},
            env: owner.env,
            agentDirs: [owner.agentDir],
            loadAuthStore: loadAuthProfileStoreWithoutExternalProfiles,
          });
          expect(prepared).not.toBeNull();
          activateSecretsRuntimeSnapshotState({
            snapshot: prepared!.snapshot,
            refreshContext: prepared!.refreshContext,
            refreshHandler: null,
          });
        });
      } else if (mode === "admitted") {
        const { prepareSecretsRuntimeSnapshot } = await import("../../secrets/runtime.js");
        await withEnvAsync(owner.env, async () => {
          const snapshot = await prepareSecretsRuntimeSnapshot({
            config: {},
            env: owner.env,
            agentDirs: [owner.agentDir],
            includeConfigRefs: false,
            loadAuthStore: loadAuthProfileStoreWithoutExternalProfiles,
          });
          activateSecretsRuntimeSnapshotState({
            snapshot,
            refreshContext: null,
            refreshHandler: null,
          });
        });
      }
      const observations: CanonicalAuthProfileCredentialObservation[] = [];
      await withEnvAsync(owner.env, () =>
        withCanonicalAuthProfileCredentialObserver(
          (value) => observations.push(value),
          async () => {
            const selected = ensureAuthProfileStoreWithoutExternalProfiles(owner.agentDir);
            expect(selected.profiles).toEqual({
              shared: apiKey("observed"),
              local: apiKey("observed-local"),
            });
          },
        ),
      );
      // NakedClaw: the agent's login landed in the shared store; its own database
      // owns no credentials (assumption 7).
      expect(observations).toEqual(
        expect.arrayContaining([
          {
            databasePath: owner.sharedPath,
            profiles: { shared: apiKey("observed"), local: apiKey("observed-local") },
          },
        ]),
      );
      expect(observations.some((value) => value.databasePath === owner.agentPath)).toBe(false);
    },
  );

  // NakedClaw: removed the tests of an agent's own legacy auth.json found before an
  // empty agent store activates; agent files are ignored (assumption 7).

  it.each(["update", "capture"] as const)(
    "honors an explicit state root over the enclosing scope during %s",
    async (operation) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      // NakedClaw: only the scoped run's agent directory has a snapshot of its own (assumption 7).
      setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
        snapshotAt(first.sharedPath)!,
        first.agentPath,
        first.agentDir,
        {
          databasePath: first.agentPath,
          sharedDatabasePath: first.sharedPath,
          location: "state-db",
        },
      );
      await withAuthProfileStoreAgentDir(first.agentDir, second.stateDir, async () => {
        if (operation === "update") {
          await updateAuthProfileStoreWithLock({
            agentDir: first.agentDir,
            stateDir: first.stateDir,
            saveOptions,
            updater: (current) => {
              current.profiles = { local: apiKey("updated-local") };
              return true;
            },
          });
        } else {
          const snapshot = captureAuthProfileStorePersistenceSnapshot(first.agentDir, {
            stateDir: first.stateDir,
          });
          const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
            snapshot,
            agentDir: first.agentDir,
            store: { version: 1, profiles: { local: apiKey("updated-local") } },
            options: saveOptions,
          });
          expect(committed.publishRuntimeSnapshots()).toBe(true);
        }
      });
      expect(snapshotAt(first.agentPath)?.profiles).toEqual({
        local: apiKey("updated-local"),
        shared: apiKey("first"),
      });
      expect(snapshotAt(second.sharedPath)?.profiles.shared).toEqual(apiKey("second"));
    },
  );

  // NakedClaw: removed the test of inherited provenance after a local rebuild; agent
  // stores no longer inherit (assumption 7).

  // NakedClaw: no agent-local case; agents have no stores of their own (assumption 7).
  it("keeps runtime-only rows out of unrelated shared batch persistence", async () => {
    const root = await seedRoot("original");
    const agentDir = undefined;
    const databasePath = root.sharedPath;
    const durableProfileId = "shared";
    const durableCredential = apiKey("original");
    const staleProfileId = "openai:removed";
    const staleFenceId = "openai:stale-fence";
    const externalProfileId = "anthropic:runtime-external";
    const expiredOAuth = {
      type: "oauth",
      provider: "openai",
      access: "expired-access",
      refresh: "consumed-refresh",
      expires: Date.now() - 60_000,
    } satisfies AuthProfileCredential;
    const staleFence = createOAuthRefreshFence({
      profileId: staleFenceId,
      credential: expiredOAuth,
    });

    withEnv(root.env, () => {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            [durableProfileId]: durableCredential,
            [staleProfileId]: apiKey("removed"),
            [staleFenceId]: staleFence,
          },
        },
        agentDir,
      );
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir),
        agentDir,
      );
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [durableProfileId]: durableCredential } },
        agentDir,
      );

      const runtimeStore = snapshotAt(databasePath);
      if (!runtimeStore) {
        throw new Error("missing runtime auth profile snapshot");
      }
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...runtimeStore,
          profiles: {
            ...runtimeStore.profiles,
            [externalProfileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "external-access",
              refresh: "external-refresh",
              expires: Date.now() + 60_000,
            },
          },
          runtimeExternalProfileIds: [externalProfileId],
        },
        agentDir,
      );
    });

    await persistAuthProfileBatch({
      stateDir: root.stateDir,
      agentDir,
      profiles: [{ profileId: "openai:unrelated", credential: apiKey("unrelated") }],
    });

    const persisted = loadPersistedSharedAuthProfileStore(root.env);
    expect(persisted?.profiles).toEqual({
      [durableProfileId]: durableCredential,
      "openai:unrelated": apiKey("unrelated"),
    });
    expect(snapshotAt(databasePath)?.profiles).toMatchObject({
      [durableProfileId]: durableCredential,
      "openai:unrelated": apiKey("unrelated"),
      [externalProfileId]: {
        access: "external-access",
        refresh: "external-refresh",
      },
    });
    expect(snapshotAt(databasePath)?.profiles[staleProfileId]).toBeUndefined();
    expect(snapshotAt(databasePath)?.profiles[staleFenceId]).toBeUndefined();
  });

  // NakedClaw: no unreadable local store case; agents have no stores of their own
  // (assumption 7).
  // NakedClaw: an empty shared store saved beside a legacy oauth.json no longer
  // records a migration refusal (that was found while rebuilding agent snapshots);
  // only Doctor imports older credentials (assumptions 6 and 7).
  it("validates committed shared migration facts for a populated store", async () => {
    const root = await seedRoot("original");
    const oauthDir = tempDirs.make("openclaw-auth-owner-late-oauth-");
    const env = { ...root.env, OPENCLAW_OAUTH_DIR: oauthDir };
    withEnv(env, () =>
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
        root.agentDir,
      ),
    );
    const legacyPath = path.join(oauthDir, "oauth.json");
    fs.writeFileSync(legacyPath, "{}");
    withEnv(env, () =>
      saveAuthProfileStore(
        { version: 1, profiles: { shared: apiKey("updated") } },
        undefined,
        saveOptions,
      ),
    );
    fs.unlinkSync(legacyPath);
    expect(() => assertAuthProfileMigrationReady(undefined, env)).not.toThrow();
    expect(snapshotAt(root.sharedPath)?.profiles.shared).toEqual(apiKey("updated"));
  });

  it.each(["credentials", "state"] as const)(
    "records committed %s changes and evicts derived snapshots when migration refuses publication",
    async (kind) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const readToken =
        kind === "credentials"
          ? getRuntimeAuthProfileStoreCredentialMutationToken
          : getRuntimeAuthProfileStoreStateMutationToken;
      const before = withEnv(first.env, () => readToken().revision);
      markAuthProfileMigrationRequired(
        undefined,
        new AuthProfileMigrationRequiredError({
          env: first.env,
          sources: [],
        }),
        first.env,
      );
      const next =
        kind === "credentials"
          ? store("updated-first")
          : {
              ...store("first"),
              order: { openai: ["shared"] },
            };
      withEnv(second.env, () =>
        saveAuthProfileStore(
          next,
          undefined,
          saveOptions,
          openOpenClawStateDatabase({ env: first.env }),
        ),
      );
      expect(loadPersistedSharedAuthProfileStore(first.env)).toMatchObject(next);
      expect(snapshotAt(first.sharedPath)).toBeUndefined();
      expect(withEnv(first.env, () => readToken().revision)).toBeGreaterThan(before);
      expect(snapshotAt(second.sharedPath)?.profiles.shared).toEqual(apiKey("second"));
      expect(() => assertAuthProfileMigrationReady(undefined, first.env)).toThrow(
        "requires legacy credential migration",
      );
    },
  );

  it("does not restore a credential snapshot over a newer migration refusal", async () => {
    const root = await seedRoot("original");
    const baseline = captureAuthProfileStorePersistenceSnapshot(root.agentDir, { env: root.env });
    const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
      snapshot: baseline,
      agentDir: root.agentDir,
      store: { version: 1, profiles: { local: apiKey("temporary") } },
      options: saveOptions,
    });
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    markAuthProfileMigrationRequired(
      root.agentDir,
      new AuthProfileMigrationRequiredError({
        agentDir: root.agentDir,
        env: root.env,
        sources: [],
      }),
      root.env,
    );
    restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned, root.agentDir);
    expect(snapshotAt(root.agentPath)).toBeUndefined();
    expect(() => assertAuthProfileMigrationReady(root.agentDir, root.env)).toThrow(
      "requires legacy credential migration",
    );
  });

  // NakedClaw: an agent's migration refusal is the shared store's (assumption 7);
  // the cases isolating a child's refusal from the shared store are gone.
  it.each([{ stateOnly: false }, { stateOnly: true }])(
    "isolates a shared rollback refusal with stateOnly=$stateOnly",
    async ({ stateOnly }) => {
      const root = await seedRoot("original");
      const unrelated = await seedRoot("unrelated");
      const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, { env: root.env });
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        store: stateOnly
          ? { ...store("original"), usageStats: { shared: { lastUsed: 99 } } }
          : store("temporary"),
        options: saveOptions,
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      markAuthProfileMigrationRequired(
        undefined,
        new AuthProfileMigrationRequiredError({ env: root.env, sources: [] }),
        root.env,
      );
      restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned);
      expect(loadPersistedSharedAuthProfileStore(root.env)?.profiles.shared).toEqual(
        apiKey("original"),
      );
      expect(snapshotAt(root.sharedPath)).toBeUndefined();
      expect(snapshotAt(unrelated.sharedPath)?.profiles.shared).toEqual(apiKey("unrelated"));
      expect(() => assertAuthProfileMigrationReady(undefined, root.env)).toThrow(
        "requires legacy credential migration",
      );
    },
  );

  // NakedClaw: removed the tests of an agent's own late auth.json and auth-state.json,
  // and of a local rebuild over an empty shared store with relocated legacy OAuth;
  // agent files are ignored and agent stores do not rebuild (assumption 7).

  it.each(
    (["transaction", "connection"] as const).flatMap((source) =>
      (["readable", "future", "invalid"] as const).map((outer) => ({ source, outer })),
    ),
  )(
    "preserves the selected shared owner for a supplied $source under a $outer ambient root",
    async ({ source, outer }) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const save = () => {
        if (source === "transaction") {
          runAuthProfileWriteTransaction(
            undefined,
            (database) =>
              saveAuthProfileStore(store("updated-first"), undefined, saveOptions, database),
            { stateDir: first.stateDir },
          );
        } else {
          saveAuthProfileStore(
            store("updated-first"),
            undefined,
            saveOptions,
            openOpenClawStateDatabase({ env: first.env }),
          );
        }
      };
      if (outer === "readable") {
        withEnv(second.env, save);
      } else {
        const assertOuterUnchanged = unreadableOuter(outer);
        save();
        assertOuterUnchanged();
      }
      expect(loadPersistedSharedAuthProfileStore(first.env)?.profiles.shared).toEqual(
        apiKey("updated-first"),
      );
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("updated-first"));
      expect(loadPersistedSharedAuthProfileStore(second.env)?.profiles.shared).toEqual(
        apiKey("second"),
      );
      expect(snapshotAt(second.sharedPath)?.profiles.shared).toEqual(apiKey("second"));
    },
  );

  // NakedClaw: removed the tests of publishing into an agent store outside the state
  // root; an agent directory names no owner of its own (assumption 7).

  it("keeps the original shared owner after a bounded temporary-state exec save", async () => {
    const original = await seedRoot("original");
    const temporary = tempDirs.make("openclaw-auth-owner-bounded-temp-");
    await withEnvAsync({ ...original.env, OPENCLAW_STATE_DIR: temporary }, async () => {
      await withAuthProfileStoreAgentDir(original.agentDir, original.stateDir, () => {
        const current = ensureAuthProfileStoreWithoutExternalProfiles();
        saveAuthProfileStore(current, undefined, saveOptions);
      });
    });
    await persistAuthProfileBatch({
      stateDir: original.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-original") }],
    });
    expect(snapshotAt(original.sharedPath)?.profiles.shared).toEqual(apiKey("updated-original"));
  });

  it("keeps relative scope paths bound to their original working directory during preparation", async ({
    signal,
  }) => {
    const stateDir = tempDirs.make("openclaw-auth-scope-state-");
    const agentDir = tempDirs.make("openclaw-auth-scope-agent-");
    const entryCwd = tempDirs.make("openclaw-auth-scope-entry-cwd-");
    const laterCwd = path.join(tempDirs.make("openclaw-auth-scope-later-cwd-"), "nested");
    fs.mkdirSync(laterCwd);
    const result = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(resolveRuntimeWorkerUrl(authProfileScopeCwdEntrypoint)),
        stateDir,
        agentDir,
        laterCwd,
      ],
      {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
      },
      undefined,
      { cwd: entryCwd, signal, requireProcessTreeExit: process.platform !== "win32" },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("retains shared OAuth in the owner snapshot but excludes it from bounded exec", async () => {
    const original = await seedRoot("original");
    const oauth = {
      type: "oauth",
      provider: "openai",
      access: "fixture-shared-access",
      refresh: "fixture-shared-refresh",
      expires: Date.now() + 3_600_000,
    } satisfies AuthProfileCredential;
    await persistAuthProfileBatch({
      stateDir: original.stateDir,
      profiles: [{ profileId: "shared-oauth", credential: oauth }],
    });
    expect(snapshotAt(original.sharedPath)?.profiles["shared-oauth"]).toEqual(oauth);
    const temporary = tempDirs.make("openclaw-auth-owner-bounded-oauth-");
    await withEnvAsync({ ...original.env, OPENCLAW_STATE_DIR: temporary }, async () => {
      await withAuthProfileStoreAgentDir(original.agentDir, original.stateDir, () => {
        const current = ensureAuthProfileStoreWithoutExternalProfiles();
        expect(current.profiles["shared-oauth"]).toBeUndefined();
        saveAuthProfileStore(current, undefined, saveOptions);
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles().profiles["shared-oauth"],
        ).toBeUndefined();
      });
    });
    expect(snapshotAt(original.sharedPath)?.profiles["shared-oauth"]).toEqual(oauth);
  });

  // NakedClaw: removed the tests of an agent snapshot owned by another root than its
  // persistence transaction; an agent's snapshot is its root's shared one (assumption 7).

  it.each(["publish", "compensate"] as const)(
    "reconciles two legacy roots sharing one relocated database during %s",
    (operation) => {
      const sharedDir = tempDirs.make("openclaw-auth-owner-aliased-legacy-");
      const roots = ["first", "second"].map(() => ({
        agentDir: tempDirs.make("openclaw-auth-owner-aliased-agent-"),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: tempDirs.make("openclaw-auth-owner-aliased-root-"),
          OPENCLAW_AGENT_DIR: sharedDir,
        },
      }));
      // NakedClaw: only a scoped run writes an agent directory's own database, here
      // the relocated legacy store both roots share (assumption 7).
      authProfileRuntimeMode.run({ kind: "agent-dir", agentDir: sharedDir, env: process.env }, () =>
        writePersistedAuthProfileStoreRaw(store("original"), sharedDir),
      );
      for (const root of roots) {
        withEnv(root.env, () =>
          setRuntimeAuthProfileStoreSnapshot(
            loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
            root.agentDir,
          ),
        );
      }
      const first = roots[0]!;
      const second = roots[1]!;
      const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, { env: first.env });
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        store: store("candidate"),
        options: saveOptions,
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      if (operation === "compensate") {
        withEnv(second.env, () =>
          setRuntimeAuthProfileStoreSnapshot(
            loadAuthProfileStoreWithoutExternalProfiles(second.agentDir),
            second.agentDir,
          ),
        );
        restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned);
      }
      // NakedClaw: both roots' agents name the relocated legacy store (assumption 7).
      expect(
        snapshotAt(withEnv(second.env, () => resolveAuthProfileStorePath(second.agentDir)))
          ?.profiles.shared,
      ).toEqual(apiKey(operation === "publish" ? "candidate" : "original"));
    },
  );

  it("activates a valid prepared owner without reopening an unrelated public cold scope", async () => {
    const first = await seedRoot("first");
    const coldAgentDir = tempDirs.make("openclaw-auth-owner-unrelated-cold-");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        databasePath: resolveAuthProfileDatabasePath(coldAgentDir),
        agentDir: coldAgentDir,
        store: store("cold"),
      },
    ]);
    const prepared = prepareSecretsRuntimeFastPathSnapshot({
      config: {},
      env: first.env,
      agentDirs: [first.agentDir],
      loadAuthStore: () =>
        withEnv(first.env, () => loadAuthProfileStoreWithoutExternalProfiles(first.agentDir)),
    });
    if (!prepared) {
      throw new Error("missing prepared snapshot");
    }
    expect(() =>
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null }),
    ).not.toThrow();
    // NakedClaw: the secrets runtime publishes only the shared store (assumption 7).
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });
});
