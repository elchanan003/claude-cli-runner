#!/usr/bin/env node
/**
 * Smoke test.
 *
 * The offline half (config guard, argv construction, usage accounting, binary
 * resolution) always runs. The live half makes two real `claude -p` calls and
 * costs a small number of tokens; skip it with SKIP_LIVE=1.
 *
 *   node test/smoke.mjs
 *   SKIP_LIVE=1 node test/smoke.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import {
  preflight,
  resolveClaudeBin,
  resetBinCache,
  ClaudeBinaryError,
  assertRunnerConfig,
  RunnerConfigError,
  buildChildEnv,
  detectCredential,
  baseArgs,
  systemPromptFlag,
  SYSTEM_PROMPT_ARGV_LIMIT,
  spawnClaudeStream,
  spawnClaudeJson,
  parseStructuredOutput,
  cleanField,
  totalTokens,
  summarizeUsage
} from "../src/index.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message.split("\n")[0]}`);
  }
}

function expectThrows(fn, Type, match) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Type, `expected ${Type.name}, got ${err.constructor.name}`);
    if (match) assert.match(err.message, match);
    return;
  }
  assert.fail("expected a throw, got none");
}

console.log("\nbinary resolution");

await test("resolveClaudeBin finds a runnable binary", () => {
  const bin = resolveClaudeBin();
  assert.ok(bin, "no binary resolved");
  if (bin !== "claude") assert.ok(existsSync(bin), `resolved path does not exist: ${bin}`);
});

await test("preflight returns a version string", () => {
  const v = preflight();
  assert.match(v, /\d+\.\d+\.\d+/, `unexpected version output: ${v}`);
});

await test("preflight throws ClaudeBinaryError on a bogus CLAUDE_BIN", () => {
  expectThrows(() => preflight("/nonexistent/definitely-not-claude"), ClaudeBinaryError, /not runnable/);
});

await test("CLAUDE_BIN overrides resolution", () => {
  const saved = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = "/some/override";
  resetBinCache();
  try {
    assert.equal(resolveClaudeBin(), "/some/override");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
    resetBinCache();
  }
});

console.log("\nsingle-operator guard");

await test("RUNNER_MODE is mandatory", () => {
  expectThrows(() => assertRunnerConfig({ bind: "127.0.0.1", credential: "oauth" }), RunnerConfigError, /RUNNER_MODE/);
});

await test("an unknown RUNNER_MODE is rejected", () => {
  expectThrows(
    () => assertRunnerConfig({ mode: "production", bind: "127.0.0.1", credential: "oauth" }),
    RunnerConfigError,
    /RUNNER_MODE/
  );
});

await test("personal + loopback + oauth is allowed with no secret", () => {
  assertRunnerConfig({ mode: "personal", bind: "127.0.0.1", credential: "oauth", hasSecret: false });
});

await test("personal + remote bind without RUNNER_ALLOW_REMOTE is refused", () => {
  expectThrows(
    () => assertRunnerConfig({ mode: "personal", bind: "0.0.0.0", credential: "oauth", hasSecret: true }),
    RunnerConfigError,
    /reachable from/
  );
});

await test("personal + remote bind without a secret is refused", () => {
  expectThrows(
    () =>
      assertRunnerConfig({ mode: "personal", bind: "0.0.0.0", allowRemote: true, credential: "oauth", hasSecret: false }),
    RunnerConfigError,
    /RUNNER_SECRET_SHA256/
  );
});

await test("personal + remote bind, acknowledged and secured, is allowed", () => {
  assertRunnerConfig({ mode: "personal", bind: "0.0.0.0", allowRemote: true, credential: "oauth", hasSecret: true });
});

await test("shared mode refuses a subscription token", () => {
  expectThrows(
    () => assertRunnerConfig({ mode: "shared", bind: "0.0.0.0", credential: "oauth", hasSecret: true }),
    RunnerConfigError,
    /requires a metered credential/
  );
});

await test("shared mode accepts an API key", () => {
  assertRunnerConfig({ mode: "shared", bind: "0.0.0.0", credential: "apiKey", hasSecret: true });
});

await test("shared mode accepts Bedrock and Vertex", () => {
  assertRunnerConfig({ mode: "shared", bind: "0.0.0.0", credential: "bedrock", hasSecret: true });
  assertRunnerConfig({ mode: "shared", bind: "0.0.0.0", credential: "vertex", hasSecret: true });
});

await test("shared mode refuses an inherited login", () => {
  expectThrows(
    () => assertRunnerConfig({ mode: "shared", bind: "0.0.0.0", credential: "inherited", hasSecret: true }),
    RunnerConfigError,
    /metered credential/
  );
});

console.log("\nchild environment");

await test("child env is minimal and carries exactly one credential", () => {
  const env = buildChildEnv({
    source: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "tok", AWS_SECRET: "leak", VERCEL_OIDC_TOKEN: "leak" },
    home: "/var/lib/runner"
  });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  assert.equal(env.HOME, "/var/lib/runner");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/var/lib/runner/.claude");
  assert.equal(env.AWS_SECRET, undefined, "unrelated host variables must not reach the child");
});

await test("an API key wins over an OAuth token", () => {
  const source = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x", CLAUDE_CODE_OAUTH_TOKEN: "tok" };
  assert.equal(detectCredential(source), "apiKey");
  const env = buildChildEnv({ source });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

await test("no credential reports as inherited", () => {
  assert.equal(detectCredential({ PATH: "/usr/bin" }), "inherited");
});

await test("Bedrock and Vertex are detected and their variables forwarded", () => {
  const bedrock = { PATH: "/usr/bin", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_PROFILE: "p" };
  assert.equal(detectCredential(bedrock), "bedrock");
  const env = buildChildEnv({ source: bedrock, home: "/h" });
  assert.equal(env.AWS_REGION, "us-east-1");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");

  const vertex = { PATH: "/usr/bin", CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" };
  assert.equal(detectCredential(vertex), "vertex");
  assert.equal(buildChildEnv({ source: vertex, home: "/h" }).CLOUD_ML_REGION, "us-east5");
});

await test("CLAUDE_RUNNER_PASSTHROUGH forwards named variables only", () => {
  const source = {
    PATH: "/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    HTTPS_PROXY: "http://proxy:3128",
    UNRELATED: "leak",
    CLAUDE_RUNNER_PASSTHROUGH: "HTTPS_PROXY"
  };
  const env = buildChildEnv({ source, home: "/h" });
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.UNRELATED, undefined);
});

await test("an inherited login inherits the environment, minimal:true opts out", () => {
  const source = { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://gw.internal", SOMETHING: "kept" };
  const inherited = buildChildEnv({ source });
  assert.equal(inherited.ANTHROPIC_BASE_URL, "https://gw.internal");
  assert.equal(inherited.SOMETHING, "kept");

  const minimal = buildChildEnv({ source, minimal: true, home: "/h" });
  assert.equal(minimal.SOMETHING, undefined);
});

await test("an inherited login is not repointed at a different config dir", () => {
  /* Forcing CLAUDE_CONFIG_DIR to <home>/.claude points the CLI away from a
     login held elsewhere and produces "Not logged in - Please run /login". */
  const env = buildChildEnv({ source: { PATH: "/usr/bin" } });
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

console.log("\nargument construction");

await test("the safety flags are all present", () => {
  const args = baseArgs("sonnet", ["--system-prompt", "hi"]);
  for (const flag of [
    "-p",
    "--tools",
    "--setting-sources",
    "--strict-mcp-config",
    "--permission-mode",
    "--no-session-persistence"
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--tools") + 1], "", '--tools must be the empty string');
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!args.includes("--bare"), "--bare breaks OAuth auth and must never be passed");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

await test("a short system prompt goes on argv", () => {
  const { flag, cleanup } = systemPromptFlag("short", "auto");
  assert.equal(flag[0], "--system-prompt");
  assert.equal(flag[1], "short");
  cleanup();
});

await test("an oversized system prompt goes to a file and cleans up", () => {
  const big = "x".repeat(SYSTEM_PROMPT_ARGV_LIMIT + 1);
  const { flag, cleanup } = systemPromptFlag(big, "auto");
  assert.equal(flag[0], "--system-prompt-file");
  assert.ok(existsSync(flag[1]), "prompt file was not written");
  assert.equal(readFileSync(flag[1], "utf8").length, big.length);
  cleanup();
  assert.ok(!existsSync(flag[1]), "prompt file was not cleaned up");
});

console.log("\nusage accounting");

await test("totalTokens counts input, both cache fields, and output", () => {
  const result = {
    usage: { input_tokens: 100, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 6000, output_tokens: 66 }
  };
  /* The bug this guards: counting output alone gives 66 instead of 56,166 —
     about 850x too generous for a budget meant to act as a kill switch. */
  assert.equal(totalTokens(result), 56_166);
  assert.notEqual(totalTokens(result), 66);
});

await test("summarizeUsage tolerates a missing usage block", () => {
  const s = summarizeUsage({});
  assert.equal(s.total, 0);
  assert.equal(s.isError, false);
});

console.log("\nstructured output");

await test("parseStructuredOutput prefers structured_output", () => {
  const out = parseStructuredOutput({ structured_output: { a: "1", b: "2" }, result: "ignored" });
  assert.deepEqual(out, { a: "1", b: "2" });
});

await test("parseStructuredOutput falls back to fenced result text", () => {
  const out = parseStructuredOutput({ result: '```json\n{"a":"1"}\n```' });
  assert.deepEqual(out, { a: "1" });
});

await test("cleanField strips the stray harness tag fragment", () => {
  assert.equal(cleanField("a real answer</parameter></invoke>"), "a real answer");
  assert.equal(cleanField("untouched"), "untouched");
});

if (process.env.SKIP_LIVE === "1") {
  console.log("\nlive calls: skipped (SKIP_LIVE=1)");
} else {
  console.log("\nlive calls (real claude -p, costs tokens)");

  await test("spawnClaudeStream streams deltas and reports usage", async () => {
    const deltas = [];
    let result = null;
    await new Promise((resolve, reject) => {
      const child = spawnClaudeStream({
        model: process.env.CHAT_MODEL || "sonnet",
        systemPrompt: "Reply with exactly one short sentence. No preamble.",
        stdinPrompt: "Name the capital of France.",
        timeoutMs: 90_000,
        onDelta: (t) => deltas.push(t),
        onResult: (r) => (result = r),
        onStderr: () => {}
      });
      child.on("close", resolve);
      child.on("error", reject);
    });
    assert.ok(deltas.length > 0, "no text deltas arrived");
    assert.match(deltas.join(""), /Paris/i);
    assert.ok(result, "no result event");
    assert.ok(totalTokens(result) > 0, "result carried no usage");
    assert.equal(result.is_error, false);
  });

  await test("spawnClaudeJson honors a two-field schema", async () => {
    const response = await spawnClaudeJson({
      model: process.env.CHAT_MODEL || "sonnet",
      systemPrompt: "Classify the sentiment of the input.",
      stdinPrompt: "This tool saved me an entire afternoon.",
      jsonSchema: {
        type: "object",
        properties: {
          sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
          confidence: { type: "number" }
        },
        required: ["sentiment", "confidence"],
        additionalProperties: false
      },
      timeoutMs: 60_000
    });
    assert.equal(response.is_error, false);
    const out = parseStructuredOutput(response);
    assert.equal(out.sentiment, "positive");
    assert.equal(typeof out.confidence, "number");
    assert.ok(totalTokens(response) > 0);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
