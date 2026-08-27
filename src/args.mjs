/**
 * The argument vector handed to `claude -p`, and how the system prompt gets
 * there.
 *
 * Extracted unchanged from tutor-local/lib/claude.mjs:61-80 (which in turn
 * matches tutor-local/local-server.mjs:247-263). The flag set is the integration
 * method — do not trim it without reading references/flags.md first.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Above this many bytes the system prompt goes to a file instead of argv.
 *
 * A prompt assembled from a knowledge digest plus a full document can run past
 * 100KB. Passed as a --system-prompt argv value that hit the sandbox's exec
 * argument size limit (`spawn E2BIG`), which is far tighter under Lambda than
 * on a normal Linux box. 32KB is comfortably under every limit involved while
 * still keeping ordinary short prompts off the disk.
 */
export const SYSTEM_PROMPT_ARGV_LIMIT = 32 * 1024;

/**
 * The safety flag set.
 *
 *   -p                        headless/print mode: one prompt in, one answer out.
 *   --model <m>               "sonnet" | "opus" | "haiku" | a full model id.
 *   --tools ""                zero tools in context. THIS is the safety
 *                             mechanism, not --dangerously-skip-permissions:
 *                             with no tools there is nothing for a prompt
 *                             injected into user-shaped input to invoke, so
 *                             there is also nothing needing a permission prompt.
 *   --setting-sources ""      ignore the host's CLAUDE.md, hooks and plugins. A
 *                             process answering requests should not inherit the
 *                             operator's personal agent configuration.
 *   --strict-mcp-config       no MCP servers, for the same reason.
 *   --permission-mode dontAsk a second layer, in case a future version ships an
 *                             always-on tool that --tools "" does not cover.
 *   --no-session-persistence  no session files accumulating per request.
 *
 * Never add --bare: its own documentation states OAuth and keychain are not
 * read under --bare, which breaks subscription auth outright.
 */
export function baseArgs(model, systemPromptFlag) {
  return [
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    ...systemPromptFlag
  ];
}

/**
 * Decides how to deliver the system prompt and returns the flag pair plus a
 * cleanup function the caller must invoke when the child exits.
 *
 * @param {string} systemPrompt
 * @param {"auto"|"arg"|"file"} [mode="auto"]
 * @param {string} [tmpDir]  where a prompt file goes; defaults to the OS temp
 *                           dir, which is /tmp under Lambda — the only writable
 *                           directory there.
 */
export function systemPromptFlag(systemPrompt, mode = "auto", tmpDir = os.tmpdir()) {
  const text = String(systemPrompt ?? "");
  const useFile = mode === "file" || (mode === "auto" && Buffer.byteLength(text, "utf8") > SYSTEM_PROMPT_ARGV_LIMIT);

  if (!useFile) {
    return { flag: ["--system-prompt", text], cleanup: () => {} };
  }

  const filePath = path.join(tmpDir, `claude-system-prompt-${randomUUID()}.txt`);
  writeFileSync(filePath, text, "utf8");
  return {
    flag: ["--system-prompt-file", filePath],
    cleanup: () => {
      try {
        unlinkSync(filePath);
      } catch {
        /* already gone, or the sandbox reclaimed it */
      }
    }
  };
}
