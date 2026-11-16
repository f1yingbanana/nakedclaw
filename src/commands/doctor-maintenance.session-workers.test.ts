import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

function begin() {
  return beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log() {}, error() {}, exit() {} },
  });
}

describe("Doctor maintenance with session workers", () => {
  // NakedClaw: Doctor never certifies canonical validation; only runtime session
  // reads and changes do (nakedclaw skill, assumptions 1 and 6).
  it("archives and restores exact cold history while Doctor holds maintenance ownership", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-cold-workers" },
      async (state) => {
        const maintenance = await begin();
        let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
        try {
          fixture = await maintenance!.run(async () => {
            const seeded = await createSessionColdStorageFixture(
              path.join(state.agentDir(), "openclaw-agent.sqlite"),
            );
            const events = loadTranscriptEventsSync(seeded.scope);
            await expect(
              runSessionColdStorageMaintenance({
                config: maintenanceConfig(seeded.scope.storePath),
              }),
            ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
            expect(readSessionColdTranscript(seeded.database(), historicalId)).toBeDefined();
            expect(() => loadTranscriptEventsSync(seeded.scope)).toThrow(
              expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
            );

            await restoreSessionColdTranscript(seeded.scope);
            expect(readSessionColdTranscript(seeded.database(), historicalId)).toBeUndefined();
            expect(loadTranscriptEventsSync(seeded.scope)).toEqual(events);
            expect(seeded.snapshot()).toEqual(seeded.original);
            return seeded;
          });
        } finally {
          await maintenance?.release();
        }
        expect(fixture.snapshot()).toEqual(fixture.original);
      },
    );
  });
});
