#!/usr/bin/env node
/**
 * Parity against the implementation this package was extracted from.
 *
 * The integration method IS the argument vector. This drives both modules with
 * a stub standing in for the CLI, captures the argv each produces, and asserts
 * they are identical — so a well-meant "cleanup" of the flag list fails here
 * rather than silently in production.
 *
 * Only meaningful with the source repo checked out alongside this one — this
 * package is standalone and most clones will not have it. Skips harmlessly
 * when the original isn't found; set ORIGINAL_CLAUDE_MJS to point at it
 * explicitly instead of relying on the sibling-checkout default.
 *
 *   node test/parity.mjs
 *   ORIGINAL_CLAUDE_MJS=/path/to/tutor-local/lib/claude.mjs node test/parity.mjs
 */
import { spawnClaudeStream } from "../src/index.mjs";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ORIGINAL =
  process.env.ORIGINAL_CLAUDE_MJS ||
  path.resolve(import.meta.dirname, "../../devops-005-gitops-guides/tutor-local/lib/claude.mjs");
if (!existsSync(ORIGINAL)) {
  console.log(`skip: no original at ${ORIGINAL}`);
  process.exit(0);
}

const work = mkdtempSync(path.join(tmpdir(), "claude-parity-"));

/* The original hardcodes its binary resolution and hands the child a minimal
   env, so the stub cannot be told where to write via an environment variable.
   Patch in a CLAUDE_BIN override and give each side its own fixed output path. */
const patched = path.join(work, "original.mjs");
writeFileSync(
  patched,
  readFileSync(ORIGINAL, "utf8").replaceAll("spawn(resolveClaudeBin()", "spawn(process.env.CLAUDE_BIN || resolveClaudeBin()")
);

function makeStub(which) {
  const p = path.join(work, `stub-${which}.sh`);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > ${work}/argv-${which}.txt\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"ok"}'\n`);
  chmodSync(p, 0o755);
  return p;
}

const CALL = { model: "sonnet", systemPrompt: "S".repeat(100), stdinPrompt: "hello", timeoutMs: 10_000 };

function capture(fn, which, extra = {}) {
  return new Promise((resolve, reject) => {
    process.env.CLAUDE_BIN = makeStub(which);
    const child = fn({ ...CALL, ...extra, onDelta() {}, onResult() {}, onRateLimit() {}, onStderr() {} });
    child.on("close", () => resolve(readFileSync(path.join(work, `argv-${which}.txt`), "utf8").trim().split("\n")));
    child.on("error", reject);
  });
}

const { spawnClaudeStream: originalStream } = await import(patched);

/* The original always writes the system prompt to a file, so pin the extracted
   one to the same mode: this compares the flag set, not the delivery heuristic. */
const original = await capture(originalStream, "original");
const extracted = await capture(spawnClaudeStream, "new", { systemPromptMode: "file" });

const normalize = (argv) => argv.map((a) => (/system-prompt-.*\.txt$/.test(a) ? "<PROMPT_FILE>" : a));

console.log("original: ", normalize(original).join(" "));
console.log("extracted:", normalize(extracted).join(" "));

assert.deepEqual(normalize(extracted), normalize(original), "argv drifted from the original implementation");
console.log("\nPARITY OK — identical argv");
