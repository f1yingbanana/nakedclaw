#!/usr/bin/env node
// Packs NakedClaw the way upstream's npm release packs OpenClaw: `@openclaw/ai`
// stays a dependency on the published package of the same version, not a copy
// bundled inside. That holds only while NakedClaw leaves `packages/ai` exactly as
// upstream released it, so this refuses to pack otherwise.
//
// Usage: node scripts/naked-pack.mjs --name <release name> [--out <dir>] [--skip-build]
// Writes <out>/openclaw-<release name>.tgz.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const name = flag("--name");
const out = path.resolve(flag("--out") ?? path.join(root, ".artifacts", "naked-pack"));
const skipBuild = args.includes("--skip-build");
if (!name || !/^[0-9A-Za-z.-]+$/.test(name)) {
  console.error(
    "usage: node scripts/naked-pack.mjs --name <release name> [--out <dir>] [--skip-build]",
  );
  process.exit(2);
}

const run = (command, commandArgs, env = {}) =>
  execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
const fail = (message) => {
  console.error(`naked-pack: ${message}`);
  process.exit(1);
};

const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const aiManifest = JSON.parse(readFileSync(path.join(root, "packages/ai/package.json"), "utf8"));
const version = rootManifest.version;
if (aiManifest.version !== version) {
  fail(`packages/ai is ${aiManifest.version}, the root ${version}.`);
}

// The upstream release this fork is based on: npm's @openclaw/ai is built from it.
const base = `v${version}`;
try {
  run("git", ["diff", "--quiet", base, "--", "packages/ai"]);
  run("git", ["diff", "--quiet", "--", "packages/ai"]);
  run("git", ["diff", "--quiet", "--cached", "--", "packages/ai"]);
} catch {
  fail(
    `packages/ai differs from upstream ${base}. Kazusa would install npm's @openclaw/ai@${version}, not this code: undo the change, or publish the package under a version of its own first.`,
  );
}
try {
  const published = run("npm", ["view", `@openclaw/ai@${version}`, "version"]).trim();
  if (published !== version) {
    throw new Error(published);
  }
} catch {
  fail(`@openclaw/ai@${version} isn't on npm, so the package couldn't install.`);
}

if (!skipBuild) {
  run("pnpm", ["build"]);
}

// Upstream's release path: built already, so prepack only checks and prepares the
// output; pnpm writes `workspace:*` as the exact version.
const staging = mkdtempSync(path.join(tmpdir(), "naked-pack-"));
try {
  run("pnpm", ["pack", "--pack-destination", staging], {
    OPENCLAW_PREPACK_PREPARED: "1",
    OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "1",
  });
  const packed = path.join(staging, `openclaw-${version}.tgz`);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", packed, "package/package.json"], { encoding: "utf8" }),
  );
  const ai = manifest.dependencies?.["@openclaw/ai"];
  if (ai !== version) {
    fail(`packed @openclaw/ai dependency is ${String(ai)}, not ${version}.`);
  }
  if ((manifest.bundleDependencies ?? []).includes("@openclaw/ai")) {
    fail("packed package still bundles @openclaw/ai.");
  }
  const entries = execFileSync("tar", ["-tzf", packed], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (entries.includes("package/node_modules/@openclaw/ai/")) {
    fail("packed package still carries a copy of @openclaw/ai.");
  }
  mkdirSync(out, { recursive: true });
  const target = path.join(out, `openclaw-${name}.tgz`);
  renameSync(packed, target);
  console.log(target);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
