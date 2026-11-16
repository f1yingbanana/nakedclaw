import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  readDeferredPluginSessionImport,
  readStaleDeferredPluginSessionImport,
} from "../../infra/deferred-plugin-session-sources.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import {
  createAgentDatabaseDeletionClassifier,
  createRetainedAgentDatabaseMatcherFromSnapshot,
} from "../../state/agent-deletion-discovery.js";
import {
  prepareAgentDatabaseDeletionSnapshotRead,
  readAgentDatabaseDeletionSnapshot,
  readAgentDeletionJournalStatusInWorker,
} from "../../state/agent-deletion-journal.read.js";
import {
  AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../../state/openclaw-agent-db-contract.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  isLegacySessionRecordOwnedByTarget,
  listLegacySessionTranscriptFiles,
  readLegacySessionStoreEntries,
  shouldFilterLegacySessionRecordsByTarget,
} from "./legacy-store-inspection.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isCanonicalSqliteSessionMainKeyCurrent } from "./session-canonical-key-read.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import {
  isConfiguredAgentDatabaseTarget,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "./targets.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { agentId?: string; storePath: string }[];
  registeredDatabases?: SessionStoreRegistryRead;
  operation?: "doctor";
}): void {
  const env = params.env ?? process.env;
  const readOptions = { env, registeredDatabases: params.registeredDatabases };
  const targets = (
    params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, readOptions)
  ).filter(
    (target) => !target.agentId || !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
  );
  const sourcesByPath = new Map<string, typeof targets>();
  for (const target of targets) {
    const sourcePath = path.resolve(target.storePath);
    sourcesByPath.set(sourcePath, [...(sourcesByPath.get(sourcePath) ?? []), target]);
  }
  const legacySources = [...sourcesByPath].filter(
    ([storePath]) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath),
  );
  if (legacySources.length === 0) {
    return;
  }
  const deletionSnapshot = readAgentDatabaseDeletionSnapshot(
    env,
    params.operation === "doctor" ? "maintenance" : "runtime",
  );
  const classifyDeletion =
    deletionSnapshot &&
    createAgentDatabaseDeletionClassifier({
      env,
      retainedDeletions: deletionSnapshot.retainedDeletions,
      registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
      configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(
        params.cfg,
        readOptions,
      ),
    });
  const legacyStore = legacySources.find(([storePath, candidates]) => {
    type SourceOwner = {
      target: { agentId: string; storePath: string };
      destination: string;
      retained: boolean;
      imported: boolean;
    };
    const owners = new Map<string, SourceOwner>();
    for (const target of candidates) {
      if (!target.agentId) {
        return true;
      }
      const destination = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        ...readOptions,
      }).path;
      const deletion =
        classifyDeletion?.(storePath, target.agentId) ??
        classifyDeletion?.(destination, target.agentId);
      const staleImport = readStaleDeferredPluginSessionImport({
        target: { ...target, agentId: target.agentId },
        sqlitePath: destination,
        env,
      });
      if (staleImport) {
        recordStartupMigrationWarnings([
          `Session import receipt belongs to another database; serving live SQLite at ${destination}. Run openclaw doctor --fix to recover retained history.`,
        ]);
      }
      // A foreign receipt leaves recovery inputs protected, not a migration veto on this database.
      const retained =
        (deletion !== undefined && deletion !== "unavailable") || Boolean(staleImport);
      owners.set(`${target.agentId}\0${destination}`, {
        target: { ...target, agentId: target.agentId },
        destination,
        retained,
        imported:
          !retained &&
          readDeferredPluginSessionImport({
            cfg: params.cfg,
            target: { ...target, agentId: target.agentId },
            sqlitePath: destination,
            env,
            purpose: "readiness",
          }) !== undefined,
      });
    }
    // A shared path still needs record-level ownership even when every candidate is held.
    if (
      [...owners.values()].every(
        ({ target, retained, imported }) =>
          (imported || retained) && !shouldFilterLegacySessionRecordsByTarget(target),
      )
    ) {
      return false;
    }
    // A roster entry is only a possible importer. Inspect retained source ownership
    // here, never in runtime session access, and bind parsed bytes to every receipt.
    const issues: Array<{ code: string; message: string; sessionKey?: string }> = [];
    const source = readLegacySessionStoreEntries({ storePath }, issues);
    if (issues.some((issue) => issue.code !== "entry_invalid") || !source.bytes) {
      return [...owners.values()].some(({ imported, retained }) => !imported && !retained);
    }
    // Empty indexes may have unindexed history: retain the existing requirement
    // for every named owner's verified receipt rather than infer ownership here.
    const required = new Set<SourceOwner>(source.entries.length === 0 ? owners.values() : []);
    for (const sessionKey of [
      ...source.entries.map((entry) => entry.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ]) {
      const matches = [...owners.values()].filter(
        ({ target }) =>
          !shouldFilterLegacySessionRecordsByTarget(target) ||
          isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
      );
      if (matches.length !== 1) {
        return true;
      }
      required.add(matches[0]!);
    }
    let hasUnindexedHistory: boolean | undefined;
    return [...required].some(({ target, destination, retained, imported }) => {
      if (
        imported ||
        (retained &&
          (source.entries.length > 0 || !shouldFilterLegacySessionRecordsByTarget(target)))
      ) {
        return false;
      }
      // Owners without a database cannot have completed a core session import.
      // Without a receipt or unindexed history, demanding one deadlocks startup:
      // Doctor refuses to create a database just for the receipt.
      if (source.entries.length === 0 && !fs.existsSync(destination)) {
        hasUnindexedHistory ??=
          listLegacySessionTranscriptFiles(path.dirname(storePath)).length > 0;
        if (!hasUnindexedHistory) {
          return false;
        }
      }
      return true;
    });
  })?.[0];
  if (legacyStore) {
    throw new SessionStoreMigrationRequiredError(
      params.operation === "doctor"
        ? formatDoctorStateRepairFailure(
            `Legacy session store requires migration at ${legacyStore}`,
            "Repair the retained source using the migration report's named file and validation error, preserving the original history.",
          )
        : `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
  deps?: {
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<void> {
  params.assertCurrent?.();
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const deletionRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  const admittedTargets = () =>
    resolveTargets(params.cfg, { env, agentIds: params.agentIds }).filter(
      (target) =>
        (!params.agentIds || params.agentIds.has(target.agentId)) &&
        !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
    );
  const targets = admittedTargets();
  // NakedClaw: a Kazusa world is created on this version and only Doctor, with
  // the Gateway stopped, ever imports older state (nakedclaw skill, assumptions 1
  // and 6). The file-store, ACP-key, legacy main-key and legacy run-outcome
  // checks that ran here for every agent at every start are gone.
  const databases = new Set<string>();
  const registeredDatabases = new Set(
    listOpenClawRegisteredAgentDatabases({ env }).map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  const configuredTargets = resolveConfiguredAgentDatabaseCandidatePaths(params.cfg, { env }).map(
    (pathname) => ({ path: pathname }),
  );
  const tasks = targets.map((target) => async () => {
    params.assertCurrent?.();
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      return;
    }
    databases.add(databasePath);
    // Retained stores remain discoverable, but only deletion cleanup may write them.
    // Check the physical owner so surviving shared stores still reach their runtime.
    const runUnlessDeleted = (operation: () => Promise<void>) =>
      deletionRead.withCurrentSnapshot((snapshot) => {
        params.assertCurrent?.();
        const retained = createRetainedAgentDatabaseMatcherFromSnapshot(
          env,
          () =>
            resolveConfiguredAgentDatabaseTargets(params.cfg, {
              env,
              registeredDatabases: (snapshot?.registeredAgentDatabases ?? []).filter(
                (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
              ),
            }),
          snapshot,
          "database",
          "runtime",
        )(databasePath, options.agentId);
        if (typeof retained === "object") {
          params.log.info(
            `session: skipping deleted agent database for ${options.agentId} at ${databasePath} (cleanup complete); run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance`,
          );
          return false;
        }
        // Missing registry entries still need recovery before runtime can discover their lineage.
        if (
          registeredDatabases.has(`${options.agentId}\0${databasePath}`) &&
          !isConfiguredAgentDatabaseTarget(configuredTargets, options.agentId, databasePath)
        ) {
          return false;
        }
        return operation().then(() => true);
      });
    const deletion = await readAgentDeletionJournalStatusInWorker(options.agentId, { env });
    params.assertCurrent?.();
    if (deletion !== "absent") {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} (${deletion === "complete" ? "cleanup complete" : "cleanup pending; retry agent deletion"})`,
      );
      return;
    }
    let alreadyOpen: boolean | undefined;
    let handedOff = false;
    try {
      if (
        !(await runUnlessDeleted(async () => {
          alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
          const mainKey = params.cfg.session?.mainKey;
          try {
            if (
              !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
              !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
            ) {
              await withOpenClawAgentDatabaseAsync(
                options,
                (database) => setCanonicalSqliteSessionMainKey(database, mainKey),
                params.assertCurrent,
              );
            }
          } catch (error) {
            params.assertCurrent?.();
            params.log.warn(
              `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
            );
          }
        }))
      ) {
        return;
      }
      // NakedClaw: the canonical-validation receipt is not renewed here, so a
      // start no longer waits on a worker per agent. A database without a
      // receipt (a copied or restored world, or one that was empty when last
      // certified) is validated at its first session read or change: on the main
      // thread, or by a worker that records the receipt on the Gateway's
      // session-row and request paths.
      const handoffDatabase = params.handoffDatabase;
      if (handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        await runUnlessDeleted(async () => {
          await handoffDatabase(options);
          params.assertCurrent?.();
          handedOff = true;
        });
      }
    } finally {
      if (alreadyOpen === false && !handedOff) {
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      }
    }
  });
  const { hasError, firstError } = await runTasksWithConcurrency({
    tasks,
    limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }
  params.assertCurrent?.();
}
