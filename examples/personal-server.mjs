#!/usr/bin/env node
/**
 * A runnable single-operator server built on claude-cli-runner.
 *
 * This is tutor-local/local-server.mjs with everything course-specific removed:
 * no class codes, no knowledge base, no GitHub issue filing, no Hebrew student
 * copy. What is left is the shape any CLI-backed service needs — auth, quotas,
 * a streaming endpoint, a schema endpoint — so it can be copied and filled in.
 *
 *   GET  /health    -> {ok, version, mode, spentToday}
 *   POST /chat      -> NDJSON: {"t":"delta","text":...} then {"t":"done",...}
 *   POST /complete  -> JSON:   the object your json_schema describes
 *
 * Both POST routes require a bearer secret (or a "secret" field in the body,
 * for callers that cannot set headers). Run:
 *
 *   RUNNER_MODE=personal node examples/personal-server.mjs
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflight,
  assertRunnerConfig,
  detectCredential,
  spawnClaudeStream,
  spawnClaudeJson,
  parseStructuredOutput,
  totalTokens,
  summarizeUsage,
  summarizeRateLimit,
  RunnerConfigError,
  ClaudeBinaryError
} from "../src/index.mjs";
import { createState, today, thisHour } from "./state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  mode: process.env.RUNNER_MODE,
  bind: process.env.BIND || "127.0.0.1",
  port: Number(process.env.PORT || 8788),
  allowRemote: process.env.RUNNER_ALLOW_REMOTE === "1",
  secretSha256: (process.env.RUNNER_SECRET_SHA256 || "").toLowerCase(),
  stateFile: process.env.STATE_FILE || path.join(__dirname, "state.json"),
  allowedOrigins: process.env.ALLOWED_ORIGINS || "*",
  model: process.env.CHAT_MODEL || "sonnet",
  jsonModel: process.env.JSON_MODEL || process.env.CHAT_MODEL || "sonnet",
  chatTimeoutMs: Number(process.env.CHAT_TIMEOUT_MS || 90_000),
  jsonTimeoutMs: Number(process.env.JSON_TIMEOUT_MS || 60_000),
  perHour: Number(process.env.CALLS_PER_HOUR || 60),
  perDay: Number(process.env.CALLS_PER_DAY || 300),
  globalPerHour: Number(process.env.GLOBAL_CALLS_PER_HOUR || 90),
  dailyTokenBudget: Number(process.env.DAILY_TOKEN_BUDGET || 3_000_000),
  maxTurns: Number(process.env.MAX_TURNS || 12),
  maxMessageChars: Number(process.env.MAX_MESSAGE_CHARS || 4000)
};

// ------------------------------------------------------------------ startup
// Fail here, loudly, rather than on the first request.

const credential = detectCredential();
try {
  assertRunnerConfig({
    mode: cfg.mode,
    bind: cfg.bind,
    allowRemote: cfg.allowRemote,
    hasSecret: Boolean(cfg.secretSha256),
    credential
  });
} catch (err) {
  if (err instanceof RunnerConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

let cliVersion;
try {
  cliVersion = preflight();
} catch (err) {
  if (err instanceof ClaudeBinaryError) {
    console.error(`\nRefusing to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

if (credential === "inherited") {
  console.warn(
    "No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set — relying on an existing interactive\n" +
      "`claude` login for this user. That works on your own machine and will NOT work in a\n" +
      "container: generate a token with `claude setup-token`."
  );
}

const state = createState(cfg.stateFile);
state.prune();

// ---------------------------------------------------------------- utilities

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Constant time for equal-length hex digests — never compare secrets with ===. */
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cors(origin) {
  const allowed = cfg.allowedOrigins.split(",").map((o) => o.trim());
  const hit = allowed[0] === "*" ? origin || "*" : origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "access-control-allow-origin": hit,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}

function sendJson(res, status, headers, body) {
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function callerKey(req, secret) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  return sha256(`${ip}|${secret}`).slice(0, 24);
}

/** Bearer header, or a `secret` field in the body. Returns {body, caller} or null. */
async function authenticate(req, res, headers) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, headers, { error: "bad request body" });
    return null;
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  const supplied = String(bearer || body.secret || "");
  if (!supplied || !cfg.secretSha256 || !sameDigest(sha256(supplied), cfg.secretSha256)) {
    sendJson(res, 401, headers, { error: "unauthorized" });
    return null;
  }
  return { body, caller: callerKey(req, supplied) };
}

/** Shared quota gate. Returns an error object to send, or null to proceed. */
function checkQuota(caller, kind) {
  if (state.budgetExhausted(cfg.dailyTokenBudget)) {
    return { status: 503, body: { error: "daily token budget exhausted" } };
  }
  /* Global first, and counted on the way in: the daily budget is only charged
     once a request finishes, so a burst can clear that check together. This key
     carries no caller in it, so it is what actually bounds a runaway client. */
  if (state.overLimit(`global:${thisHour()}`, cfg.globalPerHour, 7200)) {
    return { status: 503, body: { error: "global hourly limit reached" } };
  }
  if (state.overLimit(`${kind}:h:${caller}:${thisHour()}`, cfg.perHour, 7200)) {
    return { status: 429, body: { error: "hourly limit reached" } };
  }
  if (state.overLimit(`${kind}:d:${caller}:${today()}`, cfg.perDay, 172_800)) {
    return { status: 429, body: { error: "daily limit reached" } };
  }
  return null;
}

/**
 * Flatten prior turns into the stdin prompt: -p is single-shot, there is no
 * documented way to hand it a role-tagged conversation history in one call.
 * Keep the large, turn-invariant context in the system prompt instead, where it
 * is identical across turns and can be prompt-cached; only the short prior
 * turns are repeated in stdin.
 */
function buildUserPrompt(turns) {
  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);
  if (!prior.length) return last.content;
  const lines = ["# Conversation so far"];
  for (const t of prior) lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.content}`);
  lines.push("", "# Current message", last.content);
  return lines.join("\n");
}

function normalizeTurns(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-cfg.maxTurns)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, cfg.maxMessageChars) }));
}

// -------------------------------------------------------------------- /chat

function handleChat(req, res, headers, body, caller) {
  const turns = normalizeTurns(body.messages);
  if (!turns.length || turns[turns.length - 1].role !== "user") {
    return sendJson(res, 400, headers, { error: "messages must end with a user turn" });
  }

  res.writeHead(200, {
    ...headers,
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store"
  });

  let spent = 0;
  let sawError = null;
  let summary = null;

  const child = spawnClaudeStream({
    model: String(body.model || cfg.model),
    systemPrompt: String(body.system || "You are a helpful assistant."),
    stdinPrompt: buildUserPrompt(turns),
    timeoutMs: cfg.chatTimeoutMs,
    onDelta: (text) => res.write(JSON.stringify({ t: "delta", text }) + "\n"),
    onResult: (result) => {
      spent = totalTokens(result);
      summary = summarizeUsage(result);
      if (result.is_error) sawError = result.result || "model error";
    },
    onRateLimit: (info) => {
      const { fiveHourPct, sevenDayPct } = summarizeRateLimit(info);
      console.log(`[subscription usage] 5h ${fiveHourPct}% · 7d ${sevenDayPct}%`);
    }
  });

  /* The client hung up — stop paying for an answer nobody will read. */
  res.on("close", () => {
    if (!res.writableEnded) child.kill("SIGTERM");
  });

  child.on("close", () => {
    if (res.writableEnded) return;
    state.spendBudget(spent);
    if (sawError) res.write(JSON.stringify({ t: "error", message: sawError }) + "\n");
    else res.write(JSON.stringify({ t: "done", usage: summary }) + "\n");
    res.end();
  });

  child.on("error", (err) => {
    console.error("chat failed", err);
    if (!res.writableEnded) {
      res.write(JSON.stringify({ t: "error", message: "spawn failed" }) + "\n");
      res.end();
    }
  });
}

// ---------------------------------------------------------------- /complete

async function handleComplete(req, res, headers, body) {
  if (!body.json_schema || typeof body.json_schema !== "object") {
    return sendJson(res, 400, headers, { error: "json_schema is required" });
  }
  const prompt = String(body.prompt || "").slice(0, cfg.maxMessageChars).trim();
  if (!prompt) return sendJson(res, 400, headers, { error: "prompt is required" });

  try {
    const response = await spawnClaudeJson({
      model: String(body.model || cfg.jsonModel),
      systemPrompt: String(body.system || "Answer only in the requested JSON shape."),
      stdinPrompt: prompt,
      jsonSchema: body.json_schema,
      timeoutMs: cfg.jsonTimeoutMs
    });
    state.spendBudget(totalTokens(response));
    if (response.is_error) throw new Error(response.result || "model error");
    return sendJson(res, 200, headers, {
      output: parseStructuredOutput(response),
      usage: summarizeUsage(response)
    });
  } catch (err) {
    console.error("complete failed", err);
    return sendJson(res, 502, headers, { error: String(err.message || err) });
  }
}

// ------------------------------------------------------------------- router

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const headers = cors(req.headers.origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }

  if (url.pathname === "/health") {
    return sendJson(res, 200, headers, {
      ok: true,
      version: cliVersion,
      mode: cfg.mode,
      credential,
      spentToday: state.spentToday(),
      dailyTokenBudget: cfg.dailyTokenBudget
    });
  }

  if (req.method !== "POST") return sendJson(res, 405, headers, { error: "POST only" });

  const auth = await authenticate(req, res, headers);
  if (!auth) return;
  const { body, caller } = auth;

  if (url.pathname === "/chat") {
    const denied = checkQuota(caller, "chat");
    if (denied) return sendJson(res, denied.status, headers, denied.body);
    return handleChat(req, res, headers, body, caller);
  }
  if (url.pathname === "/complete") {
    const denied = checkQuota(caller, "complete");
    if (denied) return sendJson(res, denied.status, headers, denied.body);
    return handleComplete(req, res, headers, body);
  }
  return sendJson(res, 404, headers, { error: "not found" });
});

server.listen(cfg.port, cfg.bind, () => {
  console.log(`claude-cli-runner listening on http://${cfg.bind}:${cfg.port}`);
  console.log(`cli ${cliVersion} · model ${cfg.model} · auth ${credential} · mode ${cfg.mode}`);
  if (cfg.mode === "personal") {
    console.log("personal mode — this runs your own Claude credential. Keep the address and secret to yourself.");
  }
});

/* Containers stop with SIGTERM; without this the process is killed and the last
   state write can be lost. */
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
