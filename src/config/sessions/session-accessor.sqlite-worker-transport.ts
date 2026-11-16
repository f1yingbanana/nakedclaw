import type { Worker } from "node:worker_threads";

export type SqliteMutationWorkerTransport = { kind: "dedicated"; channel: Worker };

export type SqliteMutationWorkerEnd = { kind: "native-exit"; code: number };

export function sqliteMutationWorkerThreadId(transport: SqliteMutationWorkerTransport): number {
  return transport.channel.threadId;
}

export async function terminateSqliteMutationWorker(
  transport: SqliteMutationWorkerTransport,
): Promise<void> {
  await transport.channel.terminate();
}

export function observeSqliteMutationWorkerEnd(
  transport: SqliteMutationWorkerTransport,
  observe: (ending: SqliteMutationWorkerEnd) => void,
): () => void {
  const exited = (code: number) => observe({ kind: "native-exit", code });
  transport.channel.once("exit", exited);
  return () => transport.channel.off("exit", exited);
}
