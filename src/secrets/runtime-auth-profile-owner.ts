/** Stable SecretRef owner identity for one agent-scoped auth profile. */
import { resolveAuthProfileStorePath } from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

/**
 * Tuple encoding distinguishes stores and avoids path/profile separator collisions.
 * NakedClaw: keyed by the store that holds the profile (assumption 7).
 */
export function resolveAuthProfileSecretOwnerId(params: {
  agentDir?: string;
  profileId: string;
}): string {
  return JSON.stringify([resolveAuthProfileStorePath(params.agentDir), params.profileId]);
}

/** Enumerates the same store-scoped identities used by assignment and refresh ownership. */
export function listAuthProfileSecretOwnerIds(
  authStores: ReadonlyArray<{ agentDir: string; store: AuthProfileStore }>,
): Set<string> {
  return new Set(
    authStores.flatMap(({ agentDir, store }) =>
      Object.keys(store.profiles).map((profileId) =>
        resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
      ),
    ),
  );
}
