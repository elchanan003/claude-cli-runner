/**
 * Streaming call: `claude -p --output-format stream-json`.
 *
 * Extracted from tutor-local/lib/claude.mjs:82-128. The parsing is unchanged —
 * this is the piece that makes the CLI behave like a streaming API.
 *
 * The CLI writes newline-delimited JSON to stdout. Chunks arriving on the pipe
 * do not respect line boundaries, so lines are accumulated in a buffer and
 * split on "\n"; a line that does not parse is skipped rather than thrown on,
 * because a future CLI version emitting an event shape this code has never seen
 * must not take down a request that is otherwise fine.
 *
 * Three event types matter:
 *   stream_event / content_block_delta / text_delta  -> onDelta(text)
 *   rate_limit_event                                 -> onRateLimit(info)
 *   result                                           -> onResult(event)
 *
 * `result` is the last event and is the only place usage/cost data appears —
 * see usage.mjs.
 */
import { spawn } from "node:child_process";
import { resolveClaudeBin } from "./bin.mjs";
import { buildChildEnv } from "./env.mjs";
import { baseArgs, systemPromptFlag } from "./args.mjs";

const noop = () => {};

/**
 * @param {object}   opts
 * @param {string}   opts.model
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.stdinPrompt      the user turn, written to the child's stdin
 * @param {number}   [opts.timeoutMs=90000]
 * @param {function} [opts.onDelta]        (text) => void, per streamed text delta
 * @param {function} [opts.onResult]       (resultEvent) => void, once, at the end
 * @param {function} [opts.onRateLimit]    (rateLimitInfo) => void
 * @param {function} [opts.onStderr]       (text) => void; defaults to console.error
 * @param {string}   [opts.systemPromptMode="auto"]
 * @param {object}   [opts.env]            overrides passed to buildChildEnv
 * @returns {import("node:child_process").ChildProcess} so the caller can kill it
 *          when the downstream client disconnects.
 */
export function spawnClaudeStream({
  model,
  systemPrompt,
  stdinPrompt,
  timeoutMs = 90_000,
  onDelta = noop,
  onResult = noop,
  onRateLimit = noop,
  onStderr,
  systemPromptMode = "auto",
  env
}) {
  const { flag, cleanup } = systemPromptFlag(systemPrompt, systemPromptMode);
  const args = [...baseArgs(model, flag), "--output-format", "stream-json", "--include-partial-messages", "--verbose"];

  const child = spawn(resolveClaudeBin(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildEnv(env)
  });

  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  child.on("close", cleanupOnce);
  child.on("error", cleanupOnce);

  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.on("exit", () => clearTimeout(timer));

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        event.type === "stream_event" &&
        event.event?.type === "content_block_delta" &&
        event.event.delta?.type === "text_delta"
      ) {
        onDelta(event.event.delta.text);
      } else if (event.type === "rate_limit_event") {
        onRateLimit(event.rate_limit_info);
      } else if (event.type === "result") {
        onResult(event);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (!chunk.trim()) return;
    if (onStderr) onStderr(chunk.trim());
    else console.error("[claude stderr]", chunk.trim());
  });

  child.stdin.on("error", noop); /* the child can exit before stdin is drained */
  child.stdin.end(stdinPrompt);
  return child;
}
