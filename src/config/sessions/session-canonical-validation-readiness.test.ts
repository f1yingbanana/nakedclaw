import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import {
  markCanonicalSessionValidationPending,
  assertCanonicalSqliteSessionKeysCurrent,
} from "./session-canonical-key.js";
import {
  deferCanonicalSessionValidation,
  withCanonicalSessionValidationDeferral,
} from "./session-canonical-validation-deferral.js";
import { certifySessionCanonicalValidationPending } from "./session-canonical-validation-readiness.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

afterEach(() => vi.restoreAllMocks());

/** Captures pending work the way a runtime session read does. */
function captureCanonicalValidationPending(options: { agentId: string; path?: string }) {
  const database = openOpenClawAgentDatabase(options);
  const captured = withCanonicalSessionValidationDeferral(() =>
    deferCanonicalSessionValidation(database, !hasOpenClawAgentCanonicalValidation(database)),
  );
  if (captured.kind !== "pending") {
    throw new Error("expected pending canonical validation");
  }
  return captured.database;
}
function seedPendingRows(count: number, textBytes = 0, agentId = "main") {
  const options = { agentId };
  const database = openOpenClawAgentDatabase(options);
  const insert = database.db.prepare(`
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at)
    VALUES (?, ?, ?, 1, 1)
  `);
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const sessionId = `pending-${index}`;
      insert.run(
        `agent:${agentId}:${sessionId}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1, lastRunError: "x".repeat(textBytes) }),
      );
    }
    database.db.exec(
      "INSERT INTO session_canonical_validation_pending SELECT session_key FROM session_nodes",
    );
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  return { options, database };
}

it.each(["pending rows", "revoked receipt"] as const)(
  "certifies captured runtime work without caller-thread SQL (%s)",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database } = seedPendingRows(1);
      const deferred = withCanonicalSessionValidationDeferral(() =>
        assertCanonicalSqliteSessionKeysCurrent(database),
      );
      expect(deferred.kind).toBe("pending");
      if (deferred.kind !== "pending") {
        throw new Error("Fixture did not discover canonical work");
      }
      if (scenario === "revoked receipt") {
        database.db.exec(`
          UPDATE session_nodes SET parent_session_key = 'agent:main:changed';
          DELETE FROM session_canonical_validation_pending;
        `);
        invalidateOpenClawAgentDatabaseValidation(database.path);
      }
      const executed: string[] = [];
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
        const original = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(
          new Proxy(original, {
            apply(target, receiver: StatementSync, args) {
              executed.push(receiver.sourceSQL);
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
      });
      try {
        const certification = certifySessionCanonicalValidationPending(deferred.database);
        if (scenario === "revoked receipt") {
          await expect(certification).rejects.toThrow("invalid persisted session row");
        } else {
          await certification;
        }
        expect(executed).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
        statements.forEach((statement) => statement.mockRestore());
      }
      expect(hasPendingCanonicalSessionValidation(database)).toBe(scenario === "revoked receipt");
    });
  },
);

it("refuses drifted triggers at a new canonical admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(0);
    expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
    const peer = new DatabaseSync(database.path);
    try {
      peer.exec(
        "CREATE TRIGGER unexpected_session_trigger AFTER INSERT ON session_nodes BEGIN SELECT 1; END",
      );
    } finally {
      peer.close();
    }
    invalidateOpenClawAgentDatabaseValidation(database.path);
    await expect(
      certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options)),
    ).rejects.toThrow("Canonical validation admission changed");
  });
});

// NakedClaw: startup no longer admits populated stores through canonical validation,
// so the process-restart admission test is gone (nakedclaw skill, assumptions 1 and 6).

it("drains a large backlog in one retained worker while admitting foreground writes between batches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(260, 16 * 1024);
    const before = database.db
      .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
      .all();
    const events: string[] = [];
    let foreground: Promise<void> | undefined;
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    const started = vi
      .spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker")
      .mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type !== "reclaimed") {
            return;
          }
          events.push("batch");
          foreground ??= runOpenClawAgentWriteAdmission(options, () => {
            events.push("foreground");
          });
        });
        return worker;
      });
    await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
    await foreground;
    expect(started).toHaveBeenCalledOnce();
    expect(events[0]).toBe("batch");
    expect(events.indexOf("foreground")).toBeGreaterThan(0);
    expect(events.lastIndexOf("batch")).toBeGreaterThan(events.indexOf("foreground"));
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    expect(
      database.db
        .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
        .all(),
    ).toEqual(before);
  });
});

it.each(["row changed", "receipt revoked"] as const)(
  "retains validation authority when %s during worker admission",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { options, database } = seedPendingRows(1);
      let changed = false;
      let markerRetainedAfterFirstBatch = false;
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type === "admission-request" && !changed) {
            if (change === "row changed") {
              changed = true;
              database.db.exec(
                "UPDATE session_nodes SET parent_session_key = 'agent:main:changed'",
              );
            }
          } else if (message.type === "reclaimed") {
            if (change === "row changed") {
              markerRetainedAfterFirstBatch = hasPendingCanonicalSessionValidation(database);
            } else if (change === "receipt revoked") {
              invalidateOpenClawAgentDatabaseValidation(database.path);
            }
          }
        });
        return worker;
      });
      await expect(
        certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options)),
      ).rejects.toThrow(
        {
          "row changed": "invalid persisted session row",
          "receipt revoked": "Canonical validation admission changed",
        }[change],
      );
      if (change !== "receipt revoked") {
        expect(changed).toBe(true);
        expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      }
      if (change === "row changed") {
        expect(markerRetainedAfterFirstBatch).toBe(true);
        expect(database.db.prepare("SELECT parent_session_key FROM session_nodes").get()).toEqual({
          parent_session_key: "agent:main:changed",
        });
      } else {
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
      }
    });
  },
);

it.each([false, true])(
  "fully validates a copied populated store whose pending table is clean (invalid row: %s)",
  async (invalid) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { options, database } = seedPendingRows(130);
      await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
      const copiedPath = state.statePath("copied-agent.sqlite");
      database.db.prepare("VACUUM INTO ?").run(copiedPath);
      if (invalid) {
        const imported = new DatabaseSync(copiedPath);
        try {
          // Untrusted copied derived state cannot certify its own source contents.
          imported.exec(
            "UPDATE session_nodes SET parent_session_key = 'agent:main:changed' WHERE session_key = 'agent:main:pending-0'",
          );
          imported.exec("DELETE FROM session_canonical_validation_pending");
        } finally {
          imported.close();
        }
      }
      const copiedOptions = { ...options, path: copiedPath };
      const copied = openOpenClawAgentDatabase(copiedOptions);
      expect(hasPendingCanonicalSessionValidation(copied)).toBe(false);
      expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(false);
      const result = certifySessionCanonicalValidationPending(
        captureCanonicalValidationPending(copiedOptions),
      );
      if (invalid) {
        await expect(result).rejects.toThrow("invalid persisted session row");
        expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(false);
        expect(hasPendingCanonicalSessionValidation(copied)).toBe(true);
      } else {
        await result;
        expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(true);
        expect(hasPendingCanonicalSessionValidation(copied)).toBe(false);
      }
    });
  },
);

it("shares active runtime certification without retaining success or failure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    const entered = createDeferredCore();
    let holdNext = false;
    let resume: (() => void) | undefined;
    const jobs = vi.fn();
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = createWorker(data);
      const post = worker.postMessage.bind(worker);
      vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, ...args) => {
        if (isRecord(message) && message.type === "canonical-validation") {
          jobs();
          if (holdNext) {
            holdNext = false;
            resume = () => post(message, ...args);
            entered.resolve();
            return;
          }
        }
        post(message, ...args);
      });
      return worker;
    });
    await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
    jobs.mockClear();
    const dirty = () => {
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET entry_json = entry_json || ' '");
    };
    dirty();
    holdNext = true;
    const pending = [
      certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options)),
    ];
    try {
      await entered.promise;
      pending.push(
        ...Array.from({ length: 3 }, () =>
          certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options)),
        ),
      );
      resume?.();
      resume = undefined;
      await Promise.all(pending);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      // One shared drain seeds revoked admission, then certifies its rows.
      expect(jobs).toHaveBeenCalledTimes(2);
      dirty();
      await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(jobs).toHaveBeenCalledTimes(4);
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET parent_session_key = 'agent:main:changed'");
      const failures = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options)),
        ),
      );
      expect(failures).toEqual(
        Array.from({ length: 3 }, () => ({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringContaining("invalid persisted session row"),
          }),
        })),
      );
      expect(jobs).toHaveBeenCalledTimes(6);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      database.db.exec("UPDATE session_nodes SET parent_session_key = NULL");
      await certifySessionCanonicalValidationPending(captureCanonicalValidationPending(options));
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(jobs).toHaveBeenCalledTimes(8);
    } finally {
      resume?.();
      await Promise.allSettled(pending);
    }
  });
});
