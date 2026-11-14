import os from "node:os";
import path from "node:path";
import { resolveGatewayLockDirForCanonicalStateDir } from "../config/paths.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { memoizeStatePathResolver, resolveStatePathIdentitySync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";

/**
 * State cleanup preserves this owner until destructive work and native handles settle.
 * NakedClaw: resolved once per database path (nakedclaw skill, assumption 3).
 */
export const resolveGatewayStateOwnerPath = memoizeStatePathResolver((databasePath) => {
  const canonical = resolveStatePathIdentitySync(databasePath);
  const uid = process.getuid?.();
  // The state directory is an ancestor of the freshly canonical database path.
  const directory =
    process.platform === "win32"
      ? path.join(
          os.homedir(),
          "AppData",
          "Local",
          "OpenClaw",
          "locks",
          uid === undefined ? "openclaw-state-owners" : `openclaw-state-owners-${uid}`,
        )
      : resolveGatewayLockDirForCanonicalStateDir(
          resolveOpenClawStateDirForDatabasePath(canonical),
        );
  return path.join(
    resolveStatePathIdentitySync(directory),
    `state.${sha256HexPrefixCore(canonical, 16)}.lock`,
  );
});
