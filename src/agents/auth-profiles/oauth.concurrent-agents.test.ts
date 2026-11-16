import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import { MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.test-support.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js"));
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }, { id: "minimax-portal" }],
}));

const profileId = "openai:default";
const provider = "openai";
function read(agentDir: string | undefined) {
  assert.ok(agentDir, "expected a seeded agent directory");
  return loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
}
function resolveFrom(agentDir: string | undefined) {
  assert.ok(agentDir, "expected a seeded agent directory");
  return resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
    store: ensureAuthProfileStore(agentDir),
    profileId,
    agentDir,
  });
}

let tempRoot: string;
let mainAgentDir: string;
let envSnapshot: ReturnType<typeof captureEnv>;
let settleCaseWork: (() => Promise<void>) | undefined;
beforeEach(async () => {
  envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
  tempRoot = await createOAuthTestTempRoot("openclaw-oauth-shard-");
  mainAgentDir = await createOAuthMainAgentDir(tempRoot);
  await loadOAuthModuleForTest();
});
afterEach(async () => {
  await settleCaseWork?.();
  settleCaseWork = undefined;
  envSnapshot.restore();
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
  await removeOAuthTestTempRoot(tempRoot);
});

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  // NakedClaw: removed the tests of refresh coordination between agent copies of one
  // OAuth profile (copied generations, late peers, peer terminalization, re-login
  // retiring consumed peers); every agent uses the one shared copy (assumption 7).

  it("rejects a same-generation login write while refresh owns the generation", async () => {
    const original = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(original, mainAgentDir);

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      } as never;
    });

    const resolving = resolveFrom(mainAgentDir);
    await started;
    const originalCredential = original.profiles[profileId];
    if (originalCredential?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    await expect(
      persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [{ profileId, credential: originalCredential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      }),
    ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
    const ownerFence = read(mainAgentDir);
    expect(ownerFence?.type === "oauth" && isOAuthRefreshFence(ownerFence)).toBe(true);

    finishRefresh();
    await expect(resolving).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-access" }));
    expect(read(mainAgentDir)).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("rolls back the owner and fenced peers when a candidate is unreadable", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    const unreadableAgentDir = path.join(tempRoot, "agents", "peer-z", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    const original = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, mainAgentDir);
    await fs.writeFile(
      path.join(unreadableAgentDir, "openclaw-agent.sqlite"),
      "not a sqlite database",
    );
    await expect(resolveFrom(peerAgentDir)).rejects.toThrow();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(read(mainAgentDir)).toEqual(original.profiles[profileId]);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);
  });
});

describe("OAuth external owner boundaries", () => {
  it("refuses native refresh when durable metadata assigns the owner to an external CLI", async () => {
    const credential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "external-cli",
    });
    saveAuthProfileStore(credential, mainAgentDir);

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(mainAgentDir),
        profileId: MINIMAX_CLI_PROFILE_ID,
        agentDir: mainAgentDir,
      }),
    ).resolves.toBeNull();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      credential.profiles[MINIMAX_CLI_PROFILE_ID],
    );
  });

  it("lets native device-code login reclaim the reserved MiniMax CLI profile id", async () => {
    const credential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "external-cli",
    });
    saveAuthProfileStore(credential, mainAgentDir);
    const nativeCredential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "device-code",
    }).profiles[MINIMAX_CLI_PROFILE_ID];
    if (nativeCredential?.type !== "oauth") {
      throw new Error("expected native MiniMax OAuth credential");
    }
    await persistAuthProfileBatch({
      agentDir: mainAgentDir,
      profiles: [{ profileId: MINIMAX_CLI_PROFILE_ID, credential: nativeCredential }],
      resetFailureState: true,
      allowOAuthGenerationReplacement: true,
    });
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      nativeCredential,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
      type: "oauth",
      provider: "minimax-portal",
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(mainAgentDir),
        profileId: MINIMAX_CLI_PROFILE_ID,
        agentDir: mainAgentDir,
      }),
    ).resolves.toEqual(expect.objectContaining({ apiKey: "native-refreshed-access" }));
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    expect(
      loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID],
    ).toMatchObject({
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
    });
  });

  // NakedClaw: removed the test of fencing a peer agent's external CLI copy; agents
  // have no stores of their own (assumption 7).
});
