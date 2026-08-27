/**
 * Token accounting off the `result` event.
 *
 * This encodes the correction made in tutor-local/api/chat.mjs:100-109, which
 * until now existed only as a comment in one request handler.
 *
 * A budget must be charged for the WHOLE request, not just the reply. In the
 * course assistant the system prompt (site digest + chapter text) measures
 * ~56,000 tokens against a ~66-token answer. Counting output alone made the
 * daily budget roughly 800x too generous to ever act as the kill switch it was
 * meant to be — the budget looked like it was working and was in fact never
 * going to fire.
 *
 * Cached input still counts. It is billed at a discount rather than free, and
 * more importantly a budget is there to bound a runaway loop, which cache reads
 * do nothing to slow down.
 */

/** Every input-side token: fresh, cache writes, and cache reads. */
export function inputTokens(usage = {}) {
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
}

/**
 * What to charge a budget for one call.
 * @param {object} result the `result` event from spawnClaudeStream's onResult,
 *                 or the resolved object from spawnClaudeJson.
 */
export function totalTokens(result) {
  const usage = result?.usage || {};
  return inputTokens(usage) + (usage.output_tokens || 0);
}

/** A flat, loggable summary of one call. */
export function summarizeUsage(result) {
  const usage = result?.usage || {};
  return {
    input: usage.input_tokens || 0,
    cacheCreate: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
    total: totalTokens(result),
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    durationMs: result?.duration_ms ?? null,
    isError: Boolean(result?.is_error)
  };
}

/**
 * Percent utilization of the subscription's rolling windows, from a
 * rate_limit_event. Only meaningful under subscription (OAuth) auth — an
 * API-key run reports no such windows.
 *
 * Emitted by the CLI as `unifiedWindows: { five_hour: {utilization}, seven_day:
 * {utilization} }`, where utilization is a 0..1 fraction.
 */
export function summarizeRateLimit(info) {
  return {
    fiveHourPct: Math.round((info?.unifiedWindows?.five_hour?.utilization || 0) * 100),
    sevenDayPct: Math.round((info?.unifiedWindows?.seven_day?.utilization || 0) * 100)
  };
}
