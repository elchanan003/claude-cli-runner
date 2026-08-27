# The flag set

Produced by `baseArgs()` in `claude-cli-runner/src/args.mjs`. Byte-identical to
the original in `tutor-local/lib/claude.mjs`; `npm run parity` asserts it.

```
-p
--model <alias|id>
--tools ""
--setting-sources ""
--strict-mcp-config
--permission-mode dontAsk
--no-session-persistence
--system-prompt <text>  |  --system-prompt-file <path>
```

Plus, per call shape:

```
streaming:  --output-format stream-json --include-partial-messages --verbose
schema:     --json-schema <json> --output-format json
```

## Why each one is there

### `-p`
Headless/print mode: one prompt in, one answer out, no TUI. Single-shot — there
is no documented way to pass a role-tagged conversation history, which is why
callers flatten prior turns into stdin.

### `--tools ""`
**This is the safety mechanism.** The service answers user-shaped input, some of
which will contain prompt injection. With zero tools in context there is nothing
for an injected instruction to invoke — no file reads, no shell, no network
fetches. Because there is no tool to call, there is also no permission prompt to
suppress, which is why `--dangerously-skip-permissions` is **not** passed and
should not be. Reaching for that flag instead means an unattended process with
tools available and every guardrail disabled.

### `--permission-mode dontAsk`
A second layer, in case a future CLI version ships an always-on tool that
`--tools ""` does not cover. Without it such a tool would block on a prompt that
no one is there to answer, and the request would hang until the timeout.

### `--setting-sources ""`
Ignores the host's `CLAUDE.md`, hooks, plugins, and output styles. A process
answering requests should not inherit the operator's personal agent
configuration — the behavior would drift with unrelated edits to the operator's
dotfiles, and a hook could fire on request-derived content.

### `--strict-mcp-config`
No MCP servers, for the same reason: an MCP server is a tool surface.

### `--no-session-persistence`
No session files accumulating on disk, one per request.

### `--model`
Accepts the aliases `sonnet`, `opus`, `haiku`, or a full id such as
`claude-sonnet-5`. Aliases track the current generation; pin a full id when
reproducibility matters more than staying current.

### `--system-prompt` vs `--system-prompt-file`
`systemPromptFlag()` picks: inline under 32KB, file above it. See
`failure-modes.md` on `E2BIG`. Cleanup of the temp file is registered on both
`close` and `error`.

### `--output-format stream-json --include-partial-messages --verbose`
NDJSON on stdout. `--include-partial-messages` is what produces the incremental
`text_delta` events; without it you get whole messages and no streaming.
`--verbose` is required for the full event stream.

### `--json-schema <json> --output-format json`
The CLI's own harness enforces the schema and returns one object with
`structured_output` already parsed. A real upgrade over prompting for JSON and
stripping markdown fences — which is what the REST-based predecessor
(`worker/src/index.ts`) had to do, because the model it used did not reliably
honor `response_format`.

## Never add `--bare`

Its documentation states OAuth and keychain are not read under `--bare`. It
breaks subscription auth outright — the very thing this architecture exists for.

## Events on stdout

Only three types matter; everything else is ignored.

| Event | Handler |
|---|---|
| `stream_event` → `content_block_delta` → `text_delta` | `onDelta(text)` |
| `rate_limit_event` | `onRateLimit(info)` — subscription window utilization |
| `result` | `onResult(event)` — the last event; carries `usage`, `is_error`, `total_cost_usd` |

Chunks on the pipe do not respect line boundaries, so lines are accumulated in a
buffer and split on `\n`. **A line that fails to parse is skipped, not thrown
on** — a future CLI version emitting an event shape this code has never seen must
not take down an otherwise healthy request.

`rate_limit_event` reports `unifiedWindows.five_hour.utilization` and
`.seven_day.utilization` as 0..1 fractions. This is the CLI's own telemetry for
the subscription's rolling windows — unrelated to any budget your own code
keeps, and absent under API-key auth.
