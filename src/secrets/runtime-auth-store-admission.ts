import { copyCanonicalAuthProfileCredentialObservations } from "../agents/auth-profiles/credential-observation.js";
import { resolveRuntimeAuthProfileAgentDir } from "../agents/auth-profiles/runtime-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

/**
 * NakedClaw: the secrets snapshot holds the one shared credential store, not a
 * merged copy per agent (nakedclaw skill, assumption 7). An empty `agentDir`
 * names the shared store everywhere the snapshot is read; a scoped CLI run's
 * entry names its own directory. Every recovered agent used to refresh all 145.
 */
export function loadAdmittedAuthStores(
  loadAuthStore: (agentDir?: string) => AuthProfileStore,
): Array<{ agentDir: string; store: AuthProfileStore }> {
  const source = loadAuthStore(undefined);
  const store = structuredClone(source);
  copyCanonicalAuthProfileCredentialObservations(source.profiles, store.profiles);
  return [{ agentDir: resolveRuntimeAuthProfileAgentDir() ?? "", store }];
}
