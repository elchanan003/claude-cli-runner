# Serverless (Vercel / Lambda)

Container is the better target — this file exists because `tutor-local/` was
deployed to Vercel first, and the constraints discovered there are worth keeping
even though the recommended path avoids them.

Every item here is a workaround for something a long-lived container simply does
not have.

## What breaks, and the workaround

### The binary does not fit

`@anthropic-ai/claude-code` is ~230MB. The standard Vercel function bundle limit
is 250MB.

```jsonc
// vercel.json
"functions": {
  "api/chat.mjs": { "includeFiles": "node_modules/@anthropic-ai/claude-code/**", "maxDuration": 100 }
}
```

plus a project environment variable `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, which
raises the ceiling to 5GB uncompressed. Without it the deploy fails outright.

Cold starts are correspondingly bad: the platform unpacks that bundle before your
handler runs, on top of forking the binary per request.

### The filesystem is read-only

`/tmp` is the only writable directory. The CLI writes config and telemetry under
`HOME`, so `HOME=/tmp` and `CLAUDE_CONFIG_DIR=/tmp/.claude`, or the first request
fails with `EROFS`.

A container gives the process a real writable home instead, which is one less
thing that can go wrong.

### `spawn E2BIG`

The exec argument limit is far tighter in the Lambda sandbox than on a normal
Linux box, and the platform injects a large environment. Both halves of the fix
matter — a minimal child environment *and* `--system-prompt-file` for large
prompts. See `failure-modes.md`.

This is the constraint that shaped `buildChildEnv()`, and the reason the minimal
env is the default everywhere rather than a Lambda special case.

### There is no interactive login

No keychain, no `claude login`. `CLAUDE_CODE_OAUTH_TOKEN` is mandatory, not
optional as it is on a machine where you are already logged in.

### No shared disk between invocations

Every request is a fresh instance, so a `state.json` file cannot hold rate-limit
counters or the daily budget. `tutor-local/lib/state.mjs` talks to Upstash Redis
over its plain REST API — no SDK, since it is a stable documented HTTP contract
and one fewer thing to bundle.

The integration accepts either `KV_REST_API_URL`/`KV_REST_API_TOKEN` (what
Vercel's Upstash marketplace integration injects) or
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (what Upstash gives you when
you provision directly). Both provisioning paths exist and they name the same
thing differently.

A long-lived container has no concurrent-writer race, so a single JSON file is
genuinely simpler there — not a downgrade.

### `maxDuration` caps the request

Set the function's `maxDuration` **above** your own timeout so your code's
timeout fires first with a clean error, instead of the platform hard-killing the
invocation mid-stream. `tutor-local` uses 100s/70s function limits against
90s/60s code timeouts.

This also caps how long an answer can take at all — a long generation that would
be fine on a container gets killed here.

## Counters that do not carry an IP

Not serverless-specific, but it bit hardest there: `req.socket.remoteAddress` is
not reliable behind the platform's edge proxy. Use
`x-forwarded-for.split(",")[0]` — and remember that any IP-keyed limit is
defeated by rotating addresses, so the real bound has to be a global counter and
a token budget.

## If you deploy serverless anyway

Working reference: `tutor-local/vercel.json`, `tutor-local/lib/`,
`tutor-local/api/`, and `tutor-local/.env.vercel.example`.

Pass the Lambda-specific settings explicitly rather than relying on defaults:

```js
spawnClaudeStream({
  ...,
  systemPromptMode: "file",                        // never risk argv here
  env: { home: "/tmp", configDir: "/tmp/.claude" } // the only writable path
});
```
