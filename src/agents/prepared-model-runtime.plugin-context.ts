import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type {
  PluginMetadataSnapshot,
  ResolvePluginMetadataSnapshotParams,
} from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  createPluginRuntimeLoaderLogger,
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "./agent-scope-config.js";
import { createAgentRuntimeMetadataPluginIdScope } from "./harness/runtime-plugin-load-plan.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

type PreparedPluginContextInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "workspaceDir" | "loadRuntimePlugins" | "runtimePluginSelections"
>;

const emptyPluginDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

/**
 * NakedClaw: the workspace an agent's plugins load for. Kazusa installs no plugin
 * in a character's workspace; every plugin is global and resolves each agent's
 * workspace from its id at call time (nakedclaw skill, assumption 6). In a world
 * with a default workspace (every Kazusa world) every agent loads plugins for
 * the Gateway's plugin workspace (`server-startup-plugins.ts`) and borrows its
 * registry instead of loading one per agent. The agent's own workspace still
 * goes to everything else (catalogs, sessions, tools).
 */
export function resolvePreparedPluginWorkspaceDir(
  input: Pick<PreparedModelRuntimeInput, "config" | "workspaceDir">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return input.config.agents?.defaults?.workspace?.trim()
    ? (tryResolveConfiguredAgentWorkspaceDir(input.config, env) ?? input.workspaceDir)
    : input.workspaceDir;
}

export function prepareOwnedPluginMetadataSnapshotParams(
  input: PreparedPluginContextInput,
  env: NodeJS.ProcessEnv,
): ResolvePluginMetadataSnapshotParams {
  const workspaceDir = resolvePreparedPluginWorkspaceDir(input, env);
  return {
    config: input.config,
    env,
    ...(workspaceDir ? { workspaceDir, allowWorkspaceScopedCurrent: true } : {}),
    ...(input.loadRuntimePlugins && input.runtimePluginSelections && workspaceDir
      ? {
          pluginIdScope: createAgentRuntimeMetadataPluginIdScope({
            config: input.config,
            workspaceDir,
            selections: input.runtimePluginSelections,
          }),
        }
      : {}),
  };
}

/** Resolves and attaches the plugin facts owned by one prepared workspace generation. */
export function prepareOwnedPluginLoadContext(
  input: PreparedPluginContextInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  preparedMetadataSnapshot?: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts = false,
  preparedRegistry?: PluginRegistry,
): PluginMetadataSnapshot {
  const metadataSnapshot =
    preparedMetadataSnapshot ??
    resolvePluginMetadataSnapshot(prepareOwnedPluginMetadataSnapshotParams(input, env));
  if (!registry) {
    return metadataSnapshot;
  }
  const { config } = input;
  const workspaceDir =
    metadataSnapshot.workspaceDir ?? resolvePreparedPluginWorkspaceDir(input, env);
  const preparedActivation = getReusablePluginRuntimeActivation(preparedRegistry ?? registry, {
    config,
    env,
    workspaceDir,
    metadataSnapshot,
  });
  if (preparedActivation) {
    const targetContext = getPluginRuntimeLoadContext(registry);
    setPluginRuntimeLoadContext(registry, {
      ...preparedActivation,
      rawConfig: config,
      env,
      workspaceDir,
      metadataSnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
      logger: targetContext?.logger ?? createPluginRuntimeLoaderLogger(),
      expectedSourceDigests: targetContext?.expectedSourceDigests,
      preferBuiltPluginArtifacts,
    });
    return metadataSnapshot;
  }
  // The prepared owner already selected the exact metadata generation for this runtime.
  // Missing discovery facts stay empty here instead of reopening cold plugin discovery.
  const discoverySnapshot = metadataSnapshot.discovery
    ? metadataSnapshot
    : { ...metadataSnapshot, discovery: emptyPluginDiscovery };
  const context = {
    ...resolvePluginRuntimeLoadContext({
      config,
      env,
      workspaceDir,
      metadataSnapshot: discoverySnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      preferBuiltPluginArtifacts,
    }),
    metadataSnapshot,
  };
  // The prepared registry is the lifecycle-owned carrier; standalone callers keep the cold path.
  setPluginRuntimeLoadContext(registry, context);
  return metadataSnapshot;
}
