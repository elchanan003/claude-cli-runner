/**
 * Credentials, the child process's environment, and the single-operator guard.
 *
 * Extracted from tutor-local/lib/claude.mjs:32-46 and the bind guard at
 * tutor-local/local-server.mjs:58-64.
 */
import os from "node:os";
import path from "node:path";

export class RunnerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

/**
 * Variables each cloud-provider backend needs in the child. The CLI reads these
 * itself; the minimal-env policy would otherwise strip them.
 */
export const BEDROCK_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL"
];

export const VERTEX_VARS = [
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_VERTEX_BASE_URL"
];

/**
 * Which credential the child will use.
 *
 * `apiKey`  — ANTHROPIC_API_KEY. Metered API billing.
 * `bedrock` — CLAUDE_CODE_USE_BEDROCK=1 plus AWS credentials.
 * `vertex`  — CLAUDE_CODE_USE_VERTEX=1 plus GCP credentials.
 * `oauth`   — CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`. A personal
 *             subscription credential.
 * `inherited` — none of the above, and the CLI is expected to find an existing
 *             interactive login. This only works when HOME is the real home
 *             directory of a logged-in user AND the login is not held by some
 *             outer process's environment, so it is never viable in a
 *             container, a Lambda sandbox, or nested inside another agent
 *             session. Treat it as a development convenience only.
 */
export function detectCredential(source = process.env) {
  if (source.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  if (source.CLAUDE_CODE_USE_VERTEX === "1") return "vertex";
  if (source.ANTHROPIC_API_KEY) return "apiKey";
  if (source.CLAUDE_CODE_OAUTH_TOKEN) return "oauth";
  return "inherited";
}

/** Credentials that bill an organization rather than one person's subscription. */
export function isMeteredCredential(credential) {
  return credential === "apiKey" || credential === "bedrock" || credential === "vertex";
}

/**
 * A minimal, explicit environment for the child — deliberately NOT
 * `{...process.env}`.
 *
 * Vercel's Lambda injects a large number of platform variables (OIDC tokens,
 * region metadata, and so on). Spreading all of it into the child, on top of a
 * --system-prompt argv value carrying a 100KB+ system prompt, overran the
 * kernel's execve argument+environment size limit and the spawn failed with
 * E2BIG. The fix was to stop inheriting the platform's environment wholesale;
 * it stays here because a small explicit env is the right default anywhere, not
 * just under Lambda.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.home]        HOME for the child. Must be writable —
 *                                     the CLI writes config and telemetry there.
 * @param {string}  [opts.configDir]   CLAUDE_CONFIG_DIR. Defaults to <home>/.claude.
 * @param {object}   [opts.extra]      Additional variables, as literal values.
 * @param {string[]} [opts.passthrough] Names of variables to copy from `source`
 *                                      if they are set. Also read from
 *                                      CLAUDE_RUNNER_PASSTHROUGH as a
 *                                      comma-separated list. Use this when the
 *                                      CLI needs host configuration the minimal
 *                                      env would otherwise strip — a custom
 *                                      ANTHROPIC_BASE_URL, a proxy, a corporate
 *                                      CA bundle.
 * @param {object}   [opts.source]     Where to read from (tests).
 */
export function buildChildEnv(opts = {}) {
  const source = opts.source || process.env;
  const home = opts.home || source.CLAUDE_RUNNER_HOME || os.homedir();
  const configDir = opts.configDir || source.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

  /* The `inherited` credential means "use whatever login this machine already
     has", and a login can be held in places a minimal env cannot carry: a
     custom ANTHROPIC_BASE_URL, a proxy, or an outer agent session brokering
     auth for its children. Stripping the environment defeats the only thing
     that mode is for, so it inherits instead.

     This is a development convenience and reintroduces the E2BIG exposure the
     minimal env exists to avoid — a large inherited environment plus a large
     --system-prompt argv value can overrun the execve limit. Every deployment
     path in deploy/ sets an explicit credential and so gets the minimal env. */
  const inheritAll = detectCredential(source) === "inherited" && opts.minimal !== true;

  /* Under inheritance, HOME and CLAUDE_CONFIG_DIR are only forced when the
     caller actually asked for them. Pinning CLAUDE_CONFIG_DIR to <home>/.claude
     by default would point the child away from a login held somewhere else —
     which is the one thing this mode must not do. */
  const env = inheritAll
    ? {
        ...source,
        PATH: source.PATH,
        ...(opts.home ? { HOME: opts.home } : {}),
        ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {})
      }
    : {
        PATH: source.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir
      };

  /* Exactly one credential. Passing several leaves the winner up to the CLI's
     own precedence rules, which is not something a service should rely on
     implicitly. */
  const credential = detectCredential(source);
  if (credential === "apiKey") {
    env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  } else if (credential === "oauth") {
    env.CLAUDE_CODE_OAUTH_TOKEN = source.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (credential === "bedrock") {
    copyIfSet(env, source, BEDROCK_VARS);
  } else if (credential === "vertex") {
    copyIfSet(env, source, VERTEX_VARS);
  }

  const names = [
    ...(opts.passthrough || []),
    ...String(source.CLAUDE_RUNNER_PASSTHROUGH || "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
  ];
  copyIfSet(env, source, names);

  return { ...env, ...(opts.extra || {}) };
}

function copyIfSet(env, source, names) {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== "") env[name] = source[name];
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(bind) {
  return LOOPBACK.has(String(bind));
}

/**
 * The single-operator guard.
 *
 * tutor-local/local-server.mjs refuses to start unless bound to 127.0.0.1,
 * because it runs a personal subscription's model and must not answer other
 * people's requests. A homelab box has to be reachable from the owner's other
 * machines, so that exact check cannot survive — this is the equivalent that
 * can:
 *
 *   - RUNNER_MODE is mandatory and has no default, so the operating mode is
 *     always a deliberate, greppable choice in config.
 *   - "personal" on a non-loopback bind demands RUNNER_ALLOW_REMOTE=1: an
 *     explicit acknowledgment that a personal credential is now reachable over
 *     a network.
 *   - "personal" on a non-loopback bind demands a shared secret. An open port
 *     answering with someone's subscription is the failure this exists to
 *     prevent.
 *   - "shared" (anything serving people other than the account holder) refuses
 *     a subscription token outright and requires a metered credential — an API
 *     key, Bedrock, or Vertex. A subscription credential is authorized for the
 *     account holder's own use of Anthropic's products, not for a service
 *     answering requests from others.
 *
 * Throws RunnerConfigError with a message meant to be printed straight to
 * stderr before exiting.
 */
export function assertRunnerConfig({ mode, bind, allowRemote, hasSecret, credential } = {}) {
  if (mode !== "personal" && mode !== "shared") {
    throw new RunnerConfigError(
      `RUNNER_MODE must be set to "personal" or "shared" (got ${mode ? `"${mode}"` : "nothing"}).\n` +
        `  personal — you are the only caller; a subscription token is fine.\n` +
        `  shared   — anyone else can call it; requires ANTHROPIC_API_KEY.`
    );
  }

  if (mode === "shared" && !isMeteredCredential(credential)) {
    throw new RunnerConfigError(
      `RUNNER_MODE=shared requires a metered credential: ANTHROPIC_API_KEY, Bedrock, or Vertex\n` +
        `(got ${credential}).\n` +
        `A subscription token (CLAUDE_CODE_OAUTH_TOKEN) is authorized for your own use of\n` +
        `Anthropic's products, not for a service that answers other people's requests.\n` +
        `Set ANTHROPIC_API_KEY, or run with RUNNER_MODE=personal and keep it to yourself.`
    );
  }

  if (mode === "personal" && !isLoopback(bind)) {
    if (!allowRemote) {
      throw new RunnerConfigError(
        `Refusing to start: RUNNER_MODE=personal bound to ${bind}, which is reachable from\n` +
          `off this machine. This process runs your personal Claude credential.\n` +
          `  - Keep it local:  BIND=127.0.0.1\n` +
          `  - Or acknowledge the exposure for a private/homelab network: RUNNER_ALLOW_REMOTE=1\n` +
          `Do not put this address anywhere other people can reach it.`
      );
    }
    if (!hasSecret) {
      throw new RunnerConfigError(
        `Refusing to start: bound to ${bind} with no RUNNER_SECRET_SHA256 set.\n` +
          `An open port answering with your personal Claude credential is exactly what the\n` +
          `personal-mode guard exists to prevent. Set one with:\n` +
          `  printf '%s' 'a-long-random-secret' | shasum -a 256`
      );
    }
  }

  if (mode === "shared" && !hasSecret) {
    throw new RunnerConfigError(`Refusing to start: RUNNER_MODE=shared with no RUNNER_SECRET_SHA256 set.`);
  }
}
