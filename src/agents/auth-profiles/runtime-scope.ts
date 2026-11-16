import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import type { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AuthProfileStore } from "./types.js";

type AuthProfileRuntimeMode =
  | { kind: "env-only" }
  | { kind: "agent-dir"; agentDir: string; sharedStore?: AuthProfileStore; env: NodeJS.ProcessEnv };

export const authProfileRuntimeMode = new AsyncLocalStorage<AuthProfileRuntimeMode>();

// NakedClaw: every agent uses the one shared credential store; none reads or
// writes its own (nakedclaw skill, assumption 7). Kazusa saves provider keys
// only to the shared store, so per-agent stores were 145 empty reads at every
// start and recovery, and per-agent usage writes. A scoped CLI run (`--local`,
// onboarding staging) still names its own directory.
export function resolveRuntimeAuthProfileAgentDir(_agentDir?: string): string | undefined {
  const mode = authProfileRuntimeMode.getStore();
  return mode?.kind === "agent-dir" ? mode.agentDir : undefined;
}

/** Whether a scoped CLI run (`agent --local`, onboarding staging) owns this agent directory. */
export function isScopedAuthProfileAgentDir(agentDir: string): boolean {
  const scoped = resolveRuntimeAuthProfileAgentDir();
  return scoped !== undefined && path.resolve(scoped) === path.resolve(agentDir);
}

type WorkerAuthProfileWrites = {
  env: NodeJS.ProcessEnv;
  assertOwner: (env: NodeJS.ProcessEnv) => void;
  run: <T>(operation: () => T | Promise<T>) => Promise<T>;
};

const workerAuthProfileWrites = resolveGlobalSingleton(
  Symbol.for("openclaw.workerAuthProfileWrites"),
  () => new AsyncLocalStorage<WorkerAuthProfileWrites>(),
);

/** The request's work owner admits writes and closes this adapter after settlement. */
export function withWorkerAuthProfileWrites<T>(
  env: NodeJS.ProcessEnv,
  work: AsyncWorkScope,
  run: () => T,
): T {
  if (isMainThread) {
    throw new Error("Native auth writes require a worker-owned request");
  }
  const ownedEnv = cloneEnvWithPlatformSemantics(env);
  const stateDir = path.resolve(resolveStateDir(ownedEnv));
  return workerAuthProfileWrites.run(
    {
      env: ownedEnv,
      assertOwner: (currentEnv) => {
        if (path.resolve(resolveStateDir(currentEnv)) !== stateDir) {
          throw new Error("Native auth write differs from its worker state owner");
        }
      },
      // Closing still admits an OAuth claim's settlement; closed work rejects retained callers.
      // The refresh owner separately retains its native section before publishing the claim.
      run: (operation) => work.track(operation),
    },
    run,
  );
}

export function getWorkerAuthProfileWrites(): WorkerAuthProfileWrites | undefined {
  return workerAuthProfileWrites.getStore();
}

export function assertPersonalAuthProfileRuntime(): void {
  if (authProfileRuntimeMode.getStore()) {
    throw new Error("Personal model accounts are unavailable in an isolated auth-store scope.");
  }
}
