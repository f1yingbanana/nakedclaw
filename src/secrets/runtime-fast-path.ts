import { existsSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveRuntimeAuthProfileAgentDir } from "../agents/auth-profiles/runtime-scope.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileStorePath } from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveUserPath } from "../utils.js";
import { loadAdmittedAuthStores } from "./runtime-auth-store-admission.js";
import { hasCredentialBearingObjectValue, hasSecretRefCandidate } from "./runtime-secret-scan.js";
import type { SecretDefaults } from "./runtime-shared.js";
import type {
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext,
} from "./runtime-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

const RUNTIME_PATH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
] as const;

/**
 * Merges caller env with process path env needed for config and agent-dir resolution.
 */
export function mergeSecretsRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged = { ...(env ?? process.env) } as Record<string, string | undefined>;
  for (const key of RUNTIME_PATH_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;
    }
    // Tests often pass narrow env objects; path resolution still needs host path variables.
    const processValue = process.env[key];
    if (processValue !== undefined) {
      merged[key] = processValue;
    }
  }
  return merged;
}

// NakedClaw: agents have no stores of their own (assumption 7), so no snapshot
// walks every configured agent's directory; only directories a caller passed
// are carried to the next refresh.
export function resolveRefreshAgentDirs(context: SecretsRuntimeRefreshContext): string[] {
  return context.explicitAgentDirs ? [...context.explicitAgentDirs] : [];
}

export function createEmptyRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata {
  return {
    search: {
      providerSource: "none",
      diagnostics: [],
    },
    fetch: {
      providerSource: "none",
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function hasActiveRuntimeWebFetchProviderSurface(
  fetch: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  if (!isRecord(fetch)) {
    return false;
  }
  if (fetch.enabled === false) {
    return false;
  }
  if (typeof fetch.provider === "string" && fetch.provider.trim()) {
    return true;
  }
  return hasCredentialBearingObjectValue(fetch, defaults);
}

function hasRuntimeWebToolConfigSurface(config: OpenClawConfig): boolean {
  const web = config.tools?.web;
  const defaults = config.secrets?.defaults;
  const fetchExplicitlyDisabled =
    isRecord(web) && typeof web.fetch === "object" && web.fetch?.enabled === false;
  if (isRecord(web)) {
    if ("search" in web) {
      return true;
    }
    if ("fetch" in web && hasActiveRuntimeWebFetchProviderSurface(web.fetch, defaults)) {
      return true;
    }
  }
  const entries = config.plugins?.entries;
  if (!isRecord(entries)) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const pluginConfig = entry.config;
    return (
      isRecord(pluginConfig) &&
      ("webSearch" in pluginConfig || (!fetchExplicitlyDisabled && "webFetch" in pluginConfig))
    );
  });
}

export function canUseSecretsRuntimeFastPath(params: {
  sourceConfig: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
}): boolean {
  if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) {
    return false;
  }
  const defaults = params.sourceConfig.secrets?.defaults;
  if (hasSecretRefCandidate(params.sourceConfig, defaults)) {
    return false;
  }
  return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}

/**
 * Prepares a runtime snapshot without resolving refs when config and auth stores contain none.
 */
export function prepareSecretsRuntimeFastPathSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): {
  snapshot: PreparedSecretsRuntimeSnapshot;
  refreshContext: SecretsRuntimeRefreshContext;
  usesAuthStoreFallback: boolean;
} | null {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  // Capture before store reads. A live mutation during preparation must advance past
  // this watermark, or activation could overwrite it with the prepared candidate.
  const authStoreSnapshotsRevision = getRuntimeAuthProfileStoreSnapshotsRevision();
  const sourceConfig = cloneConfigWithResolutionFacts(params.config);
  const resolvedConfig = cloneConfigWithResolutionFacts(params.config);
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  const candidateDirs = uniqueStrings(
    (params.agentDirs ?? []).map((entry) => resolveUserPath(entry, runtimeEnv)),
  );
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  if (includeAuthStoreRefs) {
    // NakedClaw: one shared credential store, as in `loadAdmittedAuthStores`
    // (assumption 7).
    if (!params.loadAuthStore) {
      const agentDir = resolveRuntimeAuthProfileAgentDir();
      if (existsSync(resolveAuthProfileStorePath(agentDir, runtimeEnv))) {
        return null;
      }
      authStores = [{ agentDir: agentDir ?? "", store: { version: 1, profiles: {} } }];
    } else {
      authStores = loadAdmittedAuthStores(params.loadAuthStore);
    }
  }
  if (!canUseSecretsRuntimeFastPath({ sourceConfig, authStores })) {
    return null;
  }
  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores: prepareRuntimeAuthProfileStoreSnapshots(authStores, runtimeEnv),
    authStoreCredentialsRevision,
    authStoreSnapshotsRevision,
    warnings: [],
    degradedOwners: [],
    secretOwners: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
  };
  return {
    snapshot,
    usesAuthStoreFallback: !params.loadAuthStore,
    refreshContext: {
      env: runtimeEnv,
      explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
      includeAuthStoreRefs,
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      ...(params.loadAuthStore ? { loadAuthStore: params.loadAuthStore } : {}),
    },
  };
}
