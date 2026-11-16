import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as indexHash from "./installed-plugin-index-hash.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  nativeAdmissionStateFor,
  overlayPluginNativeAdmissions,
} from "./plugin-native-admission-state.js";

describe("native admission overlay fingerprint", () => {
  it("shares the base index fingerprint without hashing each overlay", async () => {
    const cache = createPluginCache();
    try {
      withPluginCache(cache, () => {
        const { index } = finalizePluginMetadataSnapshot(
          createPluginMetadataSnapshotFixture({
            plugins: [
              { id: "alpha", origin: "global" },
              { id: "beta", origin: "global" },
            ],
          }),
        );
        const alpha = index.plugins.find((plugin) => plugin.pluginId === "alpha")!;
        const receiptKey = `${path.resolve(alpha.rootDir)}\0addon.node`;
        nativeAdmissionStateFor(cache).receipts.set(receiptKey, { receipt: "fixture" } as never);
        const base = resolveInstalledManifestRegistryIndexFingerprint(index);
        const hash = vi.spyOn(indexHash, "hashStableJson");
        for (let agent = 0; agent < 5; agent++) {
          const overlay = overlayPluginNativeAdmissions(index, cache);
          expect(overlay).not.toBe(index);
          expect(
            overlay.plugins.find((plugin) => plugin.pluginId === "alpha")?.sourceAdmissions,
          ).toMatchObject({ [receiptKey]: { receipt: "fixture" } });
          expect(resolveInstalledManifestRegistryIndexFingerprint(overlay)).toBe(base);
          // An overlay of an overlay still answers with the base's fingerprint.
          expect(
            resolveInstalledManifestRegistryIndexFingerprint(
              overlayPluginNativeAdmissions(overlay, cache),
            ),
          ).toBe(base);
        }
        expect(hash).not.toHaveBeenCalled();
        hash.mockRestore();
        // A copy that changes anything the fingerprint covers is hashed on its own.
        const changed = { ...index, policyHash: `${index.policyHash}-changed` };
        expect(resolveInstalledManifestRegistryIndexFingerprint(changed)).not.toBe(base);
      });
    } finally {
      await retirePluginCache(cache);
    }
  });
});
