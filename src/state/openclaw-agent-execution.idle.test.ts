import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import * as native from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetGatewayWorkAdmission();
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  }),
);
const opened: { agentId: string; close: ReturnType<typeof vi.fn<() => Promise<void>>> }[] = [];
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.useFakeTimers();
  env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-idle-")) };
  opened.length = 0;
  // Exercise the real borrow/release owner without booting native workers for timer tests.
  vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementation((agentId) => {
    const close = vi.fn(async () => {});
    opened.push({ agentId, close });
    return {
      close,
      run: async () => undefined,
      failure: () => undefined,
      isPrepared: () => false,
      captureClaim: () => {
        throw new Error("Unused native claim");
      },
    };
  });
});

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent() {},
  createAdmission() {
    throw new Error("Native workers are isolated in this lifecycle fixture");
  },
};

function capture(agentId: string) {
  return captureOpenClawAgentDatabaseExecution({ agentId, env });
}

async function use(agentId: string) {
  const execution = capture(agentId);
  await execution.prepare(source);
  await execution.release();
  return execution;
}

function closedAgents() {
  return opened.filter(({ close }) => close.mock.calls.length > 0).map(({ agentId }) => agentId);
}

it("opens only two executors for six alternating agent borrows", async () => {
  for (const agentId of ["first", "second", "first", "second", "first", "second"]) {
    await use(agentId);
  }
  expect(opened.map(({ agentId }) => agentId)).toEqual(["first", "second"]);
  expect(closedAgents()).toEqual([]);
});

// NakedClaw: no idle-executor cap; every agent keeps its executor warm until
// its TTL, shutdown or a restart drain (nakedclaw skill, stage 2).
it("keeps every agent's executor warm instead of evicting beyond four", async () => {
  const agents = ["first", "second", "third", "fourth", "fifth", "sixth"];
  for (const agentId of [...agents, ...agents]) {
    await use(agentId);
  }
  expect(opened.map(({ agentId }) => agentId)).toEqual(agents);
  expect(closedAgents()).toEqual([]);
});

it("expires each executor independently and refreshes only the borrowed one", async () => {
  await use("first");
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  await use("second");
  await use("first");
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual([]);
  await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS / 2);
  expect(closedAgents()).toEqual(["first", "second"]);
  await use("first");
  expect(opened).toHaveLength(3);
});

it.each(["shutdown", "restart drain"] as const)("closes all warm executors on %s", async (mode) => {
  for (const agentId of ["first", "second", "third", "fourth"]) {
    await use(agentId);
  }
  expect(closedAgents()).toEqual([]);
  if (mode === "restart drain") {
    markGatewayRestartDraining();
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await closeOpenClawAgentDatabasesAsync();
  }
  expect(closedAgents()).toEqual(["first", "second", "third", "fourth"]);
  expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
});

it("retires only the selected physical store and shares its directory alias", async () => {
  const first = await use("first");
  await use("second");
  fs.mkdirSync(path.dirname(first.path), { recursive: true });
  const alias = path.join(env.OPENCLAW_STATE_DIR!, "alias");
  fs.symlinkSync(
    path.dirname(first.path),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const borrowed = captureOpenClawAgentDatabaseExecution({
    agentId: "first",
    env,
    path: path.join(alias, path.basename(first.path)),
  });
  await borrowed.prepare(source);
  await borrowed.release();
  expect(opened).toHaveLength(2);
  await closeOpenClawAgentDatabaseByPathAsync(borrowed.path, "first");
  expect(closedAgents()).toEqual(["first"]);
  await use("first");
  await use("second");
  expect(opened.map(({ agentId }) => agentId)).toEqual(["first", "second", "first"]);
});

it.each(["removal", "rename", "agent path", "session path"] as const)(
  "retires affected warm executors after a committed agent %s change",
  async (change) => {
    const config: OpenClawConfig = { agents: { entries: { first: {}, second: {} } } };
    setRuntimeConfigSnapshot(config);
    await use("first");
    await use("second");
    // Publication supports in-place mutations; the executor must retain resolved values.
    if (change === "removal" || change === "rename") {
      config.agents!.entries = { second: {}, ...(change === "rename" ? { renamed: {} } : {}) };
    } else if (change === "agent path") {
      const first = config.agents!.entries!.first;
      assert(first);
      first.agentDir = path.join(env.OPENCLAW_STATE_DIR!, "relocated");
    } else {
      config.session = {
        store: path.join(env.OPENCLAW_STATE_DIR!, "relocated", "{agentId}.sqlite"),
      };
    }
    setRuntimeConfigSnapshot(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(closedAgents()).toEqual(change === "session path" ? ["first", "second"] : ["first"]);
    await use("second");
    expect(opened).toHaveLength(change === "session path" ? 3 : 2);
  },
);

it("keeps warm executors through unrelated configuration publication", async () => {
  setRuntimeConfigSnapshot({ agents: { entries: { first: {}, second: {} } } });
  await use("first");
  await use("second");
  setRuntimeConfigSnapshot({
    agents: { entries: { first: { name: "New display name" }, second: {} } },
  });
  await use("first");
  await use("second");
  expect(opened).toHaveLength(2);
  expect(closedAgents()).toEqual([]);
});

it("joins config-triggered idle drainage without letting a released borrower close its successor", async () => {
  const config: OpenClawConfig = { agents: { entries: { first: {} } } };
  setRuntimeConfigSnapshot(config);
  const previous = capture("first");
  await previous.prepare(source);
  await previous.release();
  const first = opened[0];
  assert(first);
  const closing = createDeferredCore();
  first.close.mockImplementation(() => closing.promise);
  let next: ReturnType<typeof capture> | undefined;
  try {
    setRuntimeConfigSnapshot({
      ...config,
      session: { store: path.join(env.OPENCLAW_STATE_DIR!, "relocated", "{agentId}.sqlite") },
    });
    expect(() => previous.assertCurrent()).toThrow("reference is released");
    next = capture("first");
    let prepared = false;
    const preparing = next.prepare(source).then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);
    expect(opened).toHaveLength(1);
    closing.resolve();
    await preparing;
    expect(opened).toHaveLength(2);
    expect(() => previous.assertCurrent()).toThrow("reference is released");
    const staleCleanup = vi.fn(async () => undefined);
    await expect(
      previous.runExisting(source, staleCleanup, { retireNativeOnFailure: true }),
    ).rejects.toThrow("reference is released");
    expect(staleCleanup).not.toHaveBeenCalled();
    expect(opened[1]?.close).not.toHaveBeenCalled();
    next.assertCurrent();
    setRuntimeConfigSnapshot(config);
    next.assertCurrent();
    await next.release();
    expect(closedAgents()).toEqual(["first", "first"]);
    await closeOpenClawAgentDatabasesAsync();
    expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
  } finally {
    closing.resolve();
    await previous.release();
    await next?.release();
  }
});

it("drains a configuration-retired executor only after its last borrower releases", async () => {
  setRuntimeConfigSnapshot({ agents: { entries: { first: {}, second: {} } } });
  const first = capture("first");
  const joining = capture("first");
  try {
    await first.prepare(source);
    await use("second");
    setRuntimeConfigSnapshot({ agents: { entries: { second: {} } } });
    expect(closedAgents()).toEqual([]);
    await first.prepare(source);
    await first.release();
    expect(closedAgents()).toEqual([]);
    await joining.prepare(source);
    expect(opened).toHaveLength(2);
    await joining.release();
    expect(closedAgents()).toEqual(["first"]);
    await use("second");
    expect(opened).toHaveLength(2);
    await closeOpenClawAgentDatabasesAsync();
    expect(closedAgents()).toEqual(["first", "second"]);
    expect(opened.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
  } finally {
    await Promise.allSettled([first.release(), joining.release()]);
  }
});
