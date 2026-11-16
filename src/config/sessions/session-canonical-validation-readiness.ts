import { setTimeout as delay } from "node:timers/promises";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  getOpenClawAgentDatabaseValidationForTransfer,
  captureOpenClawAgentDatabaseValidationTransfer,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import type { SqliteReclamationClaim } from "./session-accessor.sqlite-reclamation-worker.types.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  withSqliteMutationWorkerLifetime,
  type SqliteMutationWorkerValidationOwner,
} from "./session-accessor.sqlite-worker-request.js";
import type { PendingCanonicalValidation } from "./session-canonical-validation-deferral.js";

const MAX_BATCH_ROWS = 128;
const MAX_BATCH_BYTES = 1024 * 1024;
const CONTENTION_BACKOFF_MS = [0, 25, 100, 250] as const;
const log = createSubsystemLogger("sessions/canonical-validation");
// Share only active runtime drains; native close/reopen creates a different owner.
const runtimeDrains = new Map<string, Promise<void>>();

/**
 * Certifies the pending work a runtime session read or change captured.
 * NakedClaw: startup no longer drains canonical validation and Doctor never
 * called this, so the native readiness probe (plain options, an injected
 * worker, an owner check) is gone; runtime callers always pass captured work
 * (nakedclaw skill, assumptions 1 and 6).
 */
export async function certifySessionCanonicalValidationPending(
  pending: PendingCanonicalValidation,
): Promise<void> {
  const assertOwnerCurrent = () => pending.assertStateCurrent();
  assertOwnerCurrent();
  const sourceEnv = pending.env ?? process.env;
  const pathname = resolveOpenClawAgentSqlitePath(pending);
  if (isIncognitoOpenClawAgentSqlitePath(pathname, pending)) {
    return;
  }
  let claim: SqliteReclamationClaim | undefined;
  let validationOwner: SqliteMutationWorkerValidationOwner | undefined;
  const source = pending.source;
  const drainKey = source.incarnation;
  let initializeCanonicalValidation = pending.initializeCanonicalValidation;
  const databaseOptions = {
    agentId: normalizeAgentId(pending.agentId),
    path: source.canonicalPath,
    env: {
      OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(
        pending.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv),
      ),
      ...(isGatewayExternallySupervised(sourceEnv) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
    },
  };
  const readValidation = () => getOpenClawAgentDatabaseValidationForTransfer(databaseOptions);
  const execution = captureOpenClawAgentDatabaseExecution(databaseOptions, {
    expectedIdentity: {
      kind: "file",
      physicalIdentity: source.key.slice(5),
      nativeLocation: source.canonicalPath,
      birthtime: source.birthtime,
    },
    requestedPath: pathname,
  });
  let oversizedRows = 0;
  try {
    return await withSqliteMutationWorkerLifetime(
      databaseOptions,
      async ({ assertCurrent: assertReadinessCurrent }) => {
        const drain = async () => {
          let contendedBatches = 0;
          let validation = readValidation();
          while (true) {
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim?.assertCurrent();
            const result = await withSqliteMutationWorkerLifetime(
              databaseOptions,
              async ({ assertCurrent, commitGate, signal }) =>
                await withSqliteReclamationWorker(
                  databaseOptions,
                  claim ?? source,
                  async (worker) => {
                    if (!claim) {
                      const receiveValidation =
                        captureOpenClawAgentDatabaseValidationTransfer(databaseOptions);
                      const assertOpeningCurrent = () => {
                        assertOwnerCurrent();
                        assertReadinessCurrent();
                        execution.assertCurrent();
                      };
                      const prepared = await worker.prepare({
                        plan: { kind: "canonical-validation" },
                        expectedSource: source,
                        assertCurrent: assertOpeningCurrent,
                        commitGate,
                        onCommitRequest: () => {
                          throw new Error("Canonical source preparation cannot request a commit");
                        },
                        withWriteAdmission: (run, reclamationAdmission) =>
                          runExclusiveSqliteSessionWrite(
                            databaseOptions,
                            async () => {
                              let refusal: { error: unknown } | undefined;
                              try {
                                assertOpeningCurrent();
                              } catch (error) {
                                refusal = { error };
                              }
                              await run(refusal);
                            },
                            "session.canonical-validation.prepare",
                            { reclamationAdmission },
                            "worker",
                            signal,
                          ),
                      });
                      assertOpeningCurrent();
                      prepared.claim.assertCurrent();
                      if (!receiveValidation(prepared.claim.identity, prepared.validation)) {
                        throw new Error("Canonical validation admission changed");
                      }
                      claim = prepared.claim;
                      validationOwner = { source: databaseOptions, claim: prepared.claim };
                      validation = readValidation();
                      initializeCanonicalValidation ||=
                        !validation ||
                        Atomics.load(new Int32Array(validation.canonicalReady), 0) !== 1;
                    }
                    const currentClaim = claim;
                    const assertCommitAllowed = () => {
                      assertOwnerCurrent();
                      assertReadinessCurrent();
                      assertCurrent();
                      execution.assertCurrent();
                      worker.assertCurrent(databaseOptions, currentClaim);
                      if (validation && readValidation() !== validation) {
                        throw new Error("Canonical validation admission changed");
                      }
                    };
                    assertCommitAllowed();
                    return await withSqliteReclamationAuthorization(
                      commitGate,
                      databaseOptions.path,
                      assertCommitAllowed,
                      (authorize) =>
                        worker.runCanonicalValidation({
                          databaseOptions,
                          claim: currentClaim,
                          validationOwner,
                          commitGate,
                          maxRows: MAX_BATCH_ROWS,
                          maxBytes: MAX_BATCH_BYTES,
                          initializeCanonicalValidation,
                          onCommitRequest: authorize,
                          withWriteAdmission: async (run, reclamationAdmission) =>
                            await runExclusiveSqliteSessionWrite(
                              databaseOptions,
                              async () => {
                                let refusal: { error: unknown } | undefined;
                                try {
                                  assertCommitAllowed();
                                } catch (error) {
                                  refusal = { error };
                                }
                                await run(refusal);
                              },
                              "session.canonical-validation.certify",
                              { reclamationAdmission },
                              "worker",
                              signal,
                            ),
                        }),
                    );
                  },
                  () => {
                    assertOwnerCurrent();
                    assertReadinessCurrent();
                    assertCurrent();
                    execution.assertCurrent();
                    claim?.assertCurrent();
                  },
                  signal,
                  pathname,
                ),
            );
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim?.assertCurrent();
            const currentValidation = readValidation();
            if (!currentValidation || (validation && validation !== currentValidation)) {
              throw new Error("SQLite session reclamation database owner is no longer current");
            }
            validation ??= currentValidation;
            oversizedRows += result.oversizedRows;
            if (!result.hasMore) {
              return;
            }
            if (initializeCanonicalValidation) {
              initializeCanonicalValidation = false;
              continue;
            }
            if (result.certifiedRows === 0) {
              const waitMs = CONTENTION_BACKOFF_MS[contendedBatches] ?? 250;
              contendedBatches = Math.min(contendedBatches + 1, CONTENTION_BACKOFF_MS.length - 1);
              await delay(waitMs);
            } else {
              contendedBatches = 0;
            }
            // The next batch rejoins both existing FIFOs behind already queued work.
          }
        };
        let completion: Promise<void> | undefined;
        let ownsDrain = false;
        try {
          assertOwnerCurrent();
          assertReadinessCurrent();
          execution.assertCurrent();
          claim?.assertCurrent();
          completion = runtimeDrains.get(drainKey);
          ownsDrain = completion === undefined;
          if (!completion) {
            completion = drain();
            runtimeDrains.set(drainKey, completion);
          }
          await completion;
          assertOwnerCurrent();
          assertReadinessCurrent();
          execution.assertCurrent();
          claim?.assertCurrent();
          const currentValidation = readValidation();
          if (
            !currentValidation ||
            Atomics.load(new Int32Array(currentValidation.canonicalReady), 0) !== 1
          ) {
            throw new Error("SQLite session reclamation database owner is no longer current");
          }
        } finally {
          if (ownsDrain && runtimeDrains.get(drainKey) === completion) {
            runtimeDrains.delete(drainKey);
          }
          await execution.release();
        }
      },
    );
  } finally {
    await execution.release();
    if (oversizedRows > 0) {
      log.warn("Canonical session validation processed oversized rows in its Worker", {
        path: pathname,
        rows: oversizedRows,
        batchByteLimit: MAX_BATCH_BYTES,
      });
    }
  }
}
