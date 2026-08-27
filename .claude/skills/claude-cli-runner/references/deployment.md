# Deploying to a container or VM

Container is the recommended target. A long-lived process removes every
workaround the serverless port needed — see `serverless-constraints.md` for what
you are avoiding.

## Before you start: decide the mode

`RUNNER_MODE` has no default. See the scope section of `SKILL.md`; the short
version is that `personal` permits a subscription token because you are the only
caller, and `shared` refuses one and requires `ANTHROPIC_API_KEY`.

A container always binds `0.0.0.0` (it must, to accept traffic from outside its
network namespace), so a personal deployment always trips the guard and needs:

```bash
RUNNER_ALLOW_REMOTE=1
RUNNER_SECRET_SHA256=$(printf '%s' 'a-long-random-secret' | shasum -a 256 | cut -d' ' -f1)
```

That is the guard working as intended: it makes exposing a personal credential
an explicit, greppable decision rather than a default.

## Get a token

```bash
claude setup-token
```

Run this on a machine where you are already logged in. There is no interactive
login and no OS keychain inside a container, so a token is mandatory — the CLI
has nothing to inherit.

**Never bake it into an image layer.** Inject at run time via `--env-file`, a
compose `env_file`, or your orchestrator's secret mechanism.

## Container

```bash
cd claude-cli-runner
cp deploy/.env.example deploy/.env      # fill in
docker compose -f deploy/compose.yaml up -d --build
curl -s localhost:8788/health
```

What the image does and why:

- **`node:22-slim` + `ca-certificates` + `tini`.** tini forwards signals
  properly, so `SIGTERM` reaches Node and the state file gets its final write.
- **A real user with a real home** (`/home/runner`). The CLI writes config and
  telemetry under `HOME`; a non-writable `HOME` fails at request time, not at
  startup. This is the container's advantage over Lambda, where `/tmp` is the
  only writable path.
- **`npm install` without `--ignore-scripts`.** The package's `postinstall`
  downloads the native binary, so the usual hardening cannot apply to this one
  dependency.
- **A named volume at `/var/lib/claude-runner`** so counters and the daily budget
  survive a restart.
- **`mem_limit: 2g`, `pids_limit: 512`.** Each request forks the ~230MB binary.
- **A `HEALTHCHECK` on `/health`,** which reports CLI version, mode, detected
  credential, and tokens spent today.

## Exposure

The compose file publishes to `127.0.0.1:8788` deliberately. Reach a homelab
instance over a private overlay — Tailscale, WireGuard — or a reverse proxy that
terminates TLS. Publishing `0.0.0.0:8788` to whatever network the host sits on
puts your personal credential behind nothing but the shared secret.

If a proxy sits in front, keep `CHAT_TIMEOUT_MS` below its request timeout so
this code's own timeout fires first with a clean error frame. Disable response
buffering for the NDJSON route, or streaming will arrive as one lump at the end
(nginx: `proxy_buffering off`).

## Bare VM with systemd

`deploy/claude-runner.service`. Assumes a checkout at `/opt/claude-cli-runner`
owned by a dedicated `runner` user with `npm install --omit=dev` already run.

```bash
sudo install -m 0600 -D deploy/.env /etc/claude-runner/env
sudo cp deploy/claude-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now claude-runner
journalctl -u claude-runner -f
```

Notes on the unit:

- `StateDirectory=claude-runner` creates and chowns `/var/lib/claude-runner`.
- `HOME` is set explicitly to it — the CLI needs a writable home.
- `StartLimitBurst=3` because the startup guards exit 1 on a misconfiguration,
  and restarting into the same bad config forever just fills the journal.
- **`MemoryDenyWriteExecute` is deliberately absent.** The binary is JIT-compiled
  and crashes under it.

## Verifying a deployment

```bash
curl -s localhost:8788/health
# {"ok":true,"version":"2.1.247 (Claude Code)","mode":"personal","credential":"oauth",...}
```

Check `credential` in that response. If it says `inherited` on a server, no token
was picked up and every model call will fail with "Not logged in" — see
`failure-modes.md`.

Then confirm auth is enforced and a real call streams:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8788/chat -d '{}'    # 401

curl -sN -X POST localhost:8788/chat \
  -H "authorization: Bearer $RUNNER_SECRET" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"say hi"}]}'
```

A bad or expired token surfaces as a clean NDJSON error frame carrying the CLI's
own message, not a hang:

```json
{"t":"error","message":"Failed to authenticate. API Error: 401 Invalid bearer token"}
```

## Operating it

- **Token expiry.** A `setup-token` credential does not last forever. When calls
  start failing with 401, regenerate and restart. Watch for it — `/health` stays
  green because the token is only exercised on a real call.
- **Subscription windows.** Under OAuth auth the CLI emits `rate_limit_event`
  with 5-hour and 7-day utilization. `examples/personal-server.mjs` logs it as
  `[subscription usage] 5h 16% · 7d 66%`. This is Anthropic's own accounting, and
  is what actually stops you — your `DAILY_TOKEN_BUDGET` is a local safety valve
  on top of it.
- **Upgrades.** The CLI's NDJSON event shapes are not a stability-guaranteed API.
  Pin the version, and run `npm run smoke` after bumping it.
