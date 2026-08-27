# Failure modes

Every entry here was hit for real while building `tutor-local/` and this
package. Symptom first, because that is what you have when you arrive.

---

## `spawn E2BIG`

**Symptom:** the spawn fails immediately. Common under Lambda/Vercel, rare on a
normal Linux box, and usually appears only once prompts grow.

**Cause:** `execve` caps the combined size of a process's arguments *and*
environment. Two things push you over it together:

1. Passing `{...process.env}` to the child. A platform environment can be large —
   Vercel's Lambda injects OIDC tokens, region metadata, and more.
2. A large `--system-prompt` argv value. A prompt assembled from a knowledge
   digest plus a full document runs past 100KB easily.

**Fix — both halves:**

- `buildChildEnv()` hands the child `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` and one
  credential, and nothing else. Never `{...process.env}`. Name anything else the
  CLI needs with `CLAUDE_RUNNER_PASSTHROUGH=HTTPS_PROXY,NODE_EXTRA_CA_CERTS`.
- `systemPromptFlag()` switches to `--system-prompt-file` above 32KB.

---

## `Not logged in · Please run /login`

**Symptom:** the server starts clean and `/health` is green; every model call
returns `is_error: true` with this message. `claude -p` run by hand in the same
shell works fine.

**Cause:** the child cannot see the credential, almost always because the
environment was narrowed. Three ways this happens:

1. **`CLAUDE_CONFIG_DIR` was pinned.** Forcing it to `$HOME/.claude` points the
   CLI away from a login held somewhere else. `buildChildEnv()` therefore leaves
   `HOME`/`CLAUDE_CONFIG_DIR` alone in `inherited` mode and only sets them when
   an explicit credential is configured or the caller asks.
2. **In a container** there is no interactive login and no OS keychain. There is
   nothing to inherit. Set `CLAUDE_CODE_OAUTH_TOKEN`.
3. **Nested inside another agent session**, or behind a gateway, auth may be
   brokered by the parent process or delivered via `ANTHROPIC_BASE_URL`. A
   minimal env strips it. Forward what is needed with
   `CLAUDE_RUNNER_PASSTHROUGH`, or set an explicit token.

**Check what the child actually receives:**

```js
import { buildChildEnv, detectCredential } from "./src/index.mjs";
console.log(detectCredential(), Object.keys(buildChildEnv()));
```

`detectCredential()` returning `inherited` on a server is the warning sign.

---

## A token budget that never fires

**Symptom:** the daily budget is set to something sane, usage is clearly high,
the limit never trips.

**Cause:** charging `usage.output_tokens` alone. When a large system prompt is
involved, output is a rounding error against the real cost. Measured in the
original: a ~56,000 token system prompt against a ~66 token answer — output-only
accounting made the budget about **850x** too generous.

**Fix:** `totalTokens(result)` — `input + cache_creation + cache_read + output`.
Cached input still counts: it is billed at a discount rather than free, and a
budget exists to bound a runaway loop, which cache reads do nothing to slow.

Charge it in `onResult`, and note the budget is only debited *after* a call
finishes — so a concurrent burst can clear the check together. A global,
counted-on-the-way-in hourly limit is what actually bounds that.

---

## Rate limits that reset when someone changes IP

**Symptom:** per-caller quotas are set, one client still consumes everything.

**Cause:** counter keys built from the caller's IP. Rotating addresses earns a
fresh allowance from every such counter.

**Fix:** keep per-caller limits for fairness, but put the real bound on keys
with no caller in them — a global hourly call cap and a daily token budget.
`examples/personal-server.mjs` checks the global limit first, before the
per-caller ones.

---

## Empty stdout, no error

**Symptom:** the child exits 0, nothing parsed, no deltas.

**Causes:**

- **Missing `--verbose` or `--include-partial-messages`** with
  `--output-format stream-json`. Without them there are no incremental
  `text_delta` events to parse.
- **Reading stdout as whole JSON.** It is NDJSON — many objects, one per line.
  Buffer and split on `\n`.
- **Non-zero exit with usable stdout.** The CLI reports some in-band failures as
  a well-formed result object carrying `is_error`. `spawnClaudeJson` treats a
  non-zero exit with parseable stdout as a result, not a crash — check
  `response.is_error`.

---

## Requests that hang until the timeout

**Causes:**

- **A permission prompt with nobody to answer it.** `--permission-mode dontAsk`
  plus `--tools ""` prevents this.
- **stdin never closed.** The CLI waits for EOF. `child.stdin.end(prompt)`.
- **The client disconnected and nothing killed the child.** It keeps generating
  on your quota. `res.on("close", () => child.kill("SIGTERM"))`.

Always set `timeoutMs`, and keep it **below** any proxy or platform request
timeout in front of the service, so your own timeout fires first with a clean
error instead of the proxy hanging up mid-stream.

---

## A stray `</tag></invoke>` in schema output

**Symptom:** a string field ends with a fragment like `</parameter></invoke>`.

**Cause:** a harness artifact of `--json-schema`, observed occasionally in
testing. Not something the model meant to write.

**Fix:** `cleanField()` / `cleanFields()`, applied by `parseStructuredOutput()`.

---

## `EPIPE` on `child.stdin`

**Cause:** the child exited before stdin was drained — usually because it failed
fast on a bad credential. The write then throws on an unhandled `error` event
and takes the process down.

**Fix:** an ignoring `child.stdin.on("error", ...)` handler, which both spawn
functions install.

---

## Intermittent spawn failures under concurrency

**Cause:** the CLI is a ~230MB native binary and every request forks one. Memory
or PID limits that look generous for a Node service are not generous for this.

**Fix:** `mem_limit: 2g` and `pids_limit: 512` in `deploy/compose.yaml`,
`MemoryMax`/`TasksMax` in the systemd unit. If you need real concurrency, queue
requests rather than raising limits indefinitely.

**Do not set `MemoryDenyWriteExecute=true`** in systemd: the binary is
JIT-compiled and will crash under it.
