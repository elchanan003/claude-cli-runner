# claude-cli-runner

Run the Claude Code CLI (`claude -p`) as a subprocess behind an HTTP service,
instead of calling the Anthropic REST API over `fetch`.

Extracted from a study-assistant backend (`tutor-local/` in the
[devops-005-gitops-guides](https://github.com/elchanan003/devops-005-gitops-guides)
repo) into a standalone package. The integration method is unchanged — same
binary, same flags, same stdin/stdout contract — factored out so it can be
reused and deployed on its own. `test/parity.mjs` asserts the argument vector
stays identical to the original's, when that repo is checked out alongside this
one; it skips harmlessly otherwise.

## Scope: one operator

This package is built for a **single-user personal or homelab deployment** — a
remote box you treat as an extension of your own machine.

That scope exists because of the credential. `CLAUDE_CODE_OAUTH_TOKEN`, from
`claude setup-token`, is a personal subscription credential: authorized for the
account holder's own use of Anthropic's products, not for a service answering
other people's requests. The original `tutor-local/local-server.mjs` refused to
bind to anything but `127.0.0.1` for exactly that reason.

A homelab box has to be reachable from your other machines, so that check could
not survive verbatim. It is replaced by a guard that can — see
[The single-operator guard](#the-single-operator-guard). The short version:

| | `RUNNER_MODE=personal` | `RUNNER_MODE=shared` |
|---|---|---|
| Who calls it | only you | anyone else |
| Subscription token | allowed | **refused at startup** |
| API key / Bedrock / Vertex | allowed | required |
| Non-loopback bind | needs `RUNNER_ALLOW_REMOTE=1` + a secret | needs a secret |

If this ever needs to serve other people, set `ANTHROPIC_API_KEY` and
`RUNNER_MODE=shared`. No code changes — the subprocess logic is identical either
way.

## Why a CLI subprocess rather than the REST API

Worth being explicit, because it is an unusual choice:

- **Subscription auth.** The CLI can run against a Claude subscription. The REST
  API cannot.
- **Schema enforcement is free.** `--json-schema` makes the CLI's own harness
  enforce the output shape. The REST-based predecessor had to prompt for JSON
  and defensively strip markdown fences off the answer.
- **Streaming without an SDK.** `--output-format stream-json` emits NDJSON on
  stdout; ~30 lines of line-buffered parsing turns it into deltas.

What you give up: a process fork per request (~230MB binary), higher latency
than a raw HTTP call, and a dependency on a CLI whose event shapes are not a
stability-guaranteed API. `test/smoke.mjs` exists to catch that last one.

---

## Install

```bash
npm install
```

Pulls `@anthropic-ai/claude-code`, whose `postinstall` downloads the native
binary. If you already have `claude` on `PATH`, resolution finds it — the
dependency is a convenience for containers, where there is no global install.

## Use as a library

```js
import { spawnClaudeStream, spawnClaudeJson, parseStructuredOutput, totalTokens } from "./src/index.mjs";

// Streaming
const child = spawnClaudeStream({
  model: "sonnet",
  systemPrompt: "You answer questions about our runbooks.",
  stdinPrompt: "How do I roll back a bad deploy?",
  timeoutMs: 90_000,
  onDelta: (text) => res.write(text),
  onResult: (result) => budget.spend(totalTokens(result)),
  onRateLimit: (info) => console.log(summarizeRateLimit(info))
});
res.on("close", () => child.kill("SIGTERM"));   // client hung up; stop paying

// Schema-constrained
const response = await spawnClaudeJson({
  model: "sonnet",
  systemPrompt: "Classify the incident.",
  stdinPrompt: text,
  jsonSchema: { type: "object", properties: { severity: { type: "string" } }, required: ["severity"] }
});
const { severity } = parseStructuredOutput(response);
```

## Run the example server

```bash
RUNNER_MODE=personal node examples/personal-server.mjs
```

`GET /health`, `POST /chat` (NDJSON stream), `POST /complete` (JSON schema).
It is a worked example, not a framework — copy it and replace the prompt
assembly with your own.

```bash
curl -sN -X POST localhost:8788/chat \
  -H "authorization: Bearer $RUNNER_SECRET" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is GitOps?"}]}'
```

## Test

```bash
npm run smoke:offline   # no model calls
npm run smoke           # + two real calls, costs a few thousand tokens
npm run parity          # argv still identical to the original
```

---

## The things that will bite you

Each of these cost real debugging time in the original implementation. They are
the reason this package exists rather than a snippet in a wiki.

### Why the child environment is minimal

`buildChildEnv()` hands the child `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` and one
credential — deliberately **not** `{...process.env}`.

A platform environment can be large (Vercel's Lambda injects OIDC tokens, region
metadata, and more). Spreading all of it into the child, on top of a
`--system-prompt` argv value carrying a 100KB+ prompt, overruns the kernel's
`execve` argument+environment limit and the spawn fails with **`E2BIG`**. A small
explicit environment is the right default anywhere.

When the CLI genuinely needs something else — a proxy, a corporate CA bundle, a
custom `ANTHROPIC_BASE_URL` — name it:

```bash
CLAUDE_RUNNER_PASSTHROUGH=HTTPS_PROXY,NODE_EXTRA_CA_CERTS
```

Bedrock and Vertex variables are forwarded automatically when
`CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` is set.

### Do not pin `CLAUDE_CONFIG_DIR` when relying on an existing login

If no credential env var is set, the runner is in `inherited` mode: it is trying
to use whatever login the machine already has. In that mode it inherits the
environment and leaves `HOME`/`CLAUDE_CONFIG_DIR` alone, because forcing
`CLAUDE_CONFIG_DIR=$HOME/.claude` points the CLI away from a login held anywhere
else and produces a flat **`Not logged in · Please run /login`** at request time,
with a perfectly healthy-looking server.

`inherited` is a development convenience. It cannot work in a container — set
`CLAUDE_CODE_OAUTH_TOKEN` there.

### Charge budgets for the whole request

`totalTokens()` counts `input + cache_creation + cache_read + output`.

Counting `output_tokens` alone is the intuitive thing and it is badly wrong when
a large system prompt is involved. In the original, a call carried a ~56,000
token system prompt against a ~66 token answer — output-only accounting made the
daily budget roughly **850x** too generous, so the kill switch was never going to
fire. Cached input still counts: it is billed at a discount, not free, and a
budget exists to bound a runaway loop, which cache reads do nothing to slow.

### `--tools ""` is the safety mechanism

Not `--dangerously-skip-permissions` — which is not passed, and should not be.

With zero tools in context there is nothing for a prompt injected into
user-shaped input to invoke, so there is also nothing that needs a permission
prompt. `--permission-mode dontAsk` is a second layer in case a future version
ships an always-on tool. `--setting-sources ""` and `--strict-mcp-config` keep
the operator's own `CLAUDE.md`, hooks, plugins and MCP servers out of a process
answering requests.

**Never add `--bare`.** Its own documentation states OAuth and keychain are not
read under it, which breaks subscription auth outright.

### Large system prompts go to a file

Over 32KB, `systemPromptFlag()` writes the prompt to a temp file and passes
`--system-prompt-file` instead of `--system-prompt`, for the same `E2BIG` reason.
Cleanup is registered on both `close` and `error`.

### Kill the child when the client disconnects

A browser that navigates away leaves the CLI generating an answer nobody will
read, on your quota. `res.on("close", () => child.kill("SIGTERM"))`.

---

## The single-operator guard

`assertRunnerConfig()` runs at startup and exits 1 with an explanation rather
than failing on the first request.

- **`RUNNER_MODE` is mandatory**, no default — the mode is always a deliberate,
  greppable choice in config.
- **`personal` + non-loopback bind** requires `RUNNER_ALLOW_REMOTE=1`: an
  explicit acknowledgment that a personal credential is now reachable over a
  network. Every container hits this, since a container must bind `0.0.0.0`.
- **`personal` + non-loopback bind** also requires `RUNNER_SECRET_SHA256`. An
  open port answering with your subscription is the failure this exists to
  prevent.
- **`shared` refuses a subscription token** and demands a metered credential.

Secrets are stored as digests and compared with `timingSafeEqual`, never `===`.

```bash
printf '%s' 'a-long-random-secret' | shasum -a 256
```

## Deploy

Container is the recommended target — see [`deploy/`](deploy/) and the Skill's
[deployment reference](.claude/skills/claude-cli-runner/references/deployment.md).

```bash
cp deploy/.env.example deploy/.env    # fill in, then:
docker compose -f deploy/compose.yaml up -d --build
curl -s localhost:8788/health
```

A long-lived container removes every workaround the serverless port needed: a
real writable `HOME`, no forced `--system-prompt-file`, no platform duration
ceiling, no external Redis for counters, no bundle size limit for the ~230MB
binary. `deploy/claude-runner.service` covers the bare-VM path.

Publish the port to loopback and reach it over a private overlay (Tailscale,
WireGuard) or a reverse proxy that terminates TLS. Do not publish `0.0.0.0:8788`
to whatever network the host sits on.
