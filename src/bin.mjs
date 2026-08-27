/**
 * Locating the Claude Code binary.
 *
 * Extracted from tutor-local/lib/claude.mjs:24-30, with the preflight check
 * from tutor-local/local-server.mjs:71-76 folded in.
 *
 * Resolution order:
 *   1. CLAUDE_BIN            — explicit override, wins over everything.
 *   2. The npm dependency    — @anthropic-ai/claude-code, located via
 *                              require.resolve so it works regardless of where
 *                              a bundler or deploy step unpacked node_modules.
 *   3. "claude" on PATH      — a global/homebrew install.
 *
 * The original hardcoded `bin/claude.exe`. That filename is correct today (the
 * package ships one native binary under that name on every platform) but it is
 * an implementation detail of the package, so this reads the package's own
 * `bin` field instead and only falls back to the hardcoded names.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export class ClaudeBinaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeBinaryError";
  }
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The binary shipped inside the npm package, or null if it isn't installed. */
function fromNodeModules() {
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve("@anthropic-ai/claude-code/package.json");
  } catch {
    return null;
  }
  const root = path.dirname(pkgJsonPath);

  const candidates = [];
  try {
    const { bin } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (typeof bin === "string") candidates.push(bin);
    else if (bin && typeof bin === "object") candidates.push(...Object.values(bin));
  } catch {
    /* fall through to the hardcoded names */
  }
  candidates.push("bin/claude.exe", "bin/claude");

  for (const rel of candidates) {
    const abs = path.join(root, rel);
    if (existsSync(abs) && isExecutable(abs)) return abs;
  }
  return null;
}

let cached = null;

/**
 * Absolute path to the binary, or the bare string "claude" when only a PATH
 * install is available. Cached — resolution touches the filesystem and the
 * answer cannot change within a process.
 */
export function resolveClaudeBin() {
  if (cached) return cached;

  if (process.env.CLAUDE_BIN) {
    cached = process.env.CLAUDE_BIN;
    return cached;
  }

  const bundled = fromNodeModules();
  if (bundled) {
    cached = bundled;
    return cached;
  }

  cached = "claude";
  return cached;
}

/** Test seam — resolveClaudeBin() caches, and the smoke test needs to re-resolve. */
export function resetBinCache() {
  cached = null;
}

/**
 * Refuse to start rather than fail on the first request. The original did this
 * inline at startup; as an exported function a caller can run it in a health
 * check too.
 *
 * @returns {string} the CLI's reported version
 */
export function preflight(bin = resolveClaudeBin()) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    throw new ClaudeBinaryError(
      `"${bin}" is not runnable (${err.code || err.message}). Install the Claude Code CLI, ` +
        `add it to PATH, or set CLAUDE_BIN to its absolute path.`
    );
  }
}
