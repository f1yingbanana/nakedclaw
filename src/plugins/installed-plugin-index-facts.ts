import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import { getPluginCache } from "./plugin-cache.js";

/** Package facts share the existing generation; mutable management inputs stay uncached. */
export function getInstalledPluginIndexFacts(
  index: InstalledPluginIndex,
): InstalledPluginIndexFacts | undefined {
  const entries = getPluginCache().metadata.indexFacts;
  const existing = entries.get(index);
  if (existing) {
    return existing;
  }
  if (!isDeeplyFrozenPlainData(index)) {
    return undefined;
  }
  const facts: InstalledPluginIndexFacts = {};
  entries.set(index, facts);
  return facts;
}

// NakedClaw: an admission overlay is a fresh copy of a cached index that differs
// only in each plugin's `sourceAdmissions`, which the index fingerprint leaves
// out. Without this the copy made for every agent's model catalog re-hashed the
// whole installed index, about 0.7 s per agent and a quarter of recovery.
const admissionOverlayBases = new WeakMap<InstalledPluginIndex, InstalledPluginIndex>();

/** Records that `overlay` is `base` with only source admissions changed. */
export function recordInstalledPluginIndexAdmissionOverlay(
  overlay: InstalledPluginIndex,
  base: InstalledPluginIndex,
): void {
  admissionOverlayBases.set(overlay, admissionOverlayBases.get(base) ?? base);
}

/** The index an admission overlay was made from, whose fingerprint it shares. */
export function getInstalledPluginIndexAdmissionOverlayBase(
  index: InstalledPluginIndex,
): InstalledPluginIndex | undefined {
  return admissionOverlayBases.get(index);
}
