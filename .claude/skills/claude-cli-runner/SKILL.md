---
name: claude-cli-runner
description: Build or deploy a service that calls Claude by spawning the Claude Code CLI (`claude -p`) as a subprocess rather than calling the REST API — streaming stream-json NDJSON off stdout, enforcing output shape with --json-schema, and running under a Claude subscription token instead of an API key. Use when wiring a chatbot, tutor, triage or classification backend to the CLI; when deploying such a service to a container, VM, homelab box, or serverless function; when debugging spawn E2BIG, "Not logged in · Please run /login", empty stdout, or token budgets that never fire; or when asked to package a local `claude -p` proof-of-concept for a server.
---

# Running the Claude Code CLI as a service backend

The working implementation is the `claude-cli-runner/` package in this
repository. **Use it rather than writing a new subprocess wrapper** — every flag
and parse rule in it is there because something broke without it.

```js
import { spawnClaudeStream, spawnClaudeJson, parseStructuredOutput, totalTokens } from "../claude-cli-runner/src/index.mjs";
```

Read `claude-cli-runner/README.md` first. It is the user-facing document; this
skill is the map to the reference material behind it.

## Scope — check this before anything else

The CLI can authenticate with a **personal Claude subscription token**
(`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`). That credential is
authorized for the account holder's own use of Anthropic's products — **not for
a service that answers other people's requests**.

So, before writing any code, establish who will call the service:

- **Only the operator** (personal tools, a homelab assistant, private testing):
  `RUNNER_MODE=personal`. A subscription token is fine.
- **Anyone else** (a team, students, customers, a public site):
  `RUNNER_MODE=shared`, which refuses a subscription token at startup and
  requires `ANTHROPIC_API_KEY`, Bedrock, or Vertex.

Nothing about the subprocess integration changes between the two — same binary,
same flags, same parsing. Only the credential differs. If the answer is unclear,
ask; do not default to the subscription token because it is cheaper.

## The shape of the integration

```
spawn(claude, ["-p", "--model", m, "--tools", "", ...])
  stdin  <- the user turn (and any prior turns, flattened)
  argv   <- the system prompt (or --system-prompt-file when large)
  stdout -> NDJSON: stream_event deltas, rate_limit_event, then one result
```

`-p` is single-shot. There is no documented way to hand it a role-tagged
conversation history, so prior turns are flattened into stdin while the large,
turn-invariant context stays in the system prompt — where it is identical across
turns and can be prompt-cached.

## References

| File | Read it when |
|---|---|
| `references/flags.md` | Choosing or changing CLI flags; asked why `--tools ""` is there or whether `--dangerously-skip-permissions` is needed |
| `references/failure-modes.md` | Anything is broken — `E2BIG`, "Not logged in", empty stdout, hangs, budgets that never fire |
| `references/deployment.md` | Deploying to a container, VM, or homelab box |
| `references/serverless-constraints.md` | Deploying to Vercel/Lambda specifically |

## Rules that are not negotiable

1. **`--tools ""` is the safety mechanism**, not `--dangerously-skip-permissions`
   (which is never passed). Zero tools in context means nothing an injected
   prompt can invoke.
2. **Never pass `--bare`.** It does not read OAuth or keychain, which breaks
   subscription auth outright.
3. **Never hand the child `{...process.env}`.** Use `buildChildEnv()`. See
   `references/failure-modes.md` on `E2BIG`.
4. **Charge budgets `input + cache_creation + cache_read + output`** via
   `totalTokens()`. Output-only accounting silently makes a budget ~850x too
   generous when a large system prompt is in play.
5. **Kill the child when the HTTP client disconnects**, or you pay for answers
   nobody reads.
6. **Never bake a credential into a container layer.** Inject at run time.

## Verifying a change

```bash
cd claude-cli-runner
npm run smoke:offline   # guards, argv, env, accounting — no model calls
npm run smoke           # + two real calls
npm run parity          # argv still identical to tutor-local/lib/claude.mjs
```

If you change the flag list, `npm run parity` will fail. That is the test doing
its job: confirm the change is deliberate, then update the original too, or
accept the divergence and note it in the README.
