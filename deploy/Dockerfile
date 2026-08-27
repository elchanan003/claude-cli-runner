# claude-cli-runner — container image.
#
# A long-lived container removes every workaround the serverless port needed:
# a real writable HOME (no HOME=/tmp), no forced --system-prompt-file, no
# platform maxDuration ceiling, no external Redis for counters, and no bundle
# size limit for the ~230MB CLI binary.
FROM node:22-slim

# The CLI is a native binary; ca-certificates is needed for its HTTPS calls and
# tini gives us correct signal forwarding so SIGTERM reaches Node and the state
# file gets its final write.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# A real user with a real home. The CLI writes config and telemetry under HOME;
# pointing it at a non-writable path fails at request time, not at startup.
RUN useradd --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner

WORKDIR /app

# postinstall downloads the native binary, so the usual --ignore-scripts
# hardening cannot apply to this one package.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && chown -R runner:runner /app

COPY src/ ./src/
COPY examples/ ./examples/

# State lives on a volume so counters and the daily budget survive a restart.
RUN mkdir -p /var/lib/claude-runner && chown runner:runner /var/lib/claude-runner
VOLUME ["/var/lib/claude-runner"]

USER runner

ENV NODE_ENV=production \
    HOME=/home/runner \
    BIND=0.0.0.0 \
    PORT=8788 \
    STATE_FILE=/var/lib/claude-runner/state.json

# BIND is 0.0.0.0 because a container has to accept traffic from outside its own
# network namespace. That is exactly the case the personal-mode guard catches,
# so a personal deployment must set RUNNER_ALLOW_REMOTE=1 and RUNNER_SECRET_SHA256
# at run time. Publish the port only to where you actually need it:
#   docker run -p 127.0.0.1:8788:8788 ...
EXPOSE 8788

# Never bake a credential into a layer — pass it at run time with --env-file.
# CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY are deliberately absent here.

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "examples/personal-server.mjs"]
