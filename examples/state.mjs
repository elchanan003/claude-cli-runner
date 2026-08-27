/**
 * Rate-limit counters and the daily token budget, in one JSON file.
 *
 * From tutor-local/local-server.mjs:78-135. A single long-lived Node process
 * has no concurrent-writer race the way a serverless deployment does, so a file
 * is genuinely simpler here — not a downgrade from Redis, just the right tool
 * for a process that owns its own state. The serverless port needed Redis
 * purely because every invocation is a fresh instance with no shared disk.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function createState(stateFile) {
  let state = { counters: {}, budget: {} };

  if (existsSync(stateFile)) {
    try {
      state = { counters: {}, budget: {}, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      console.warn(`${stateFile} unreadable, starting fresh`);
    }
  }

  function save() {
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state));
    } catch (err) {
      console.error("failed to persist state", err);
    }
  }

  /** Increments and reports whether the key is now over its limit. */
  function overLimit(key, limit, ttlSeconds) {
    const now = Date.now();
    const c = state.counters[key];
    const value = c && c.expiresAt >= now ? c.value : 0;
    if (value >= limit) return true;
    state.counters[key] = { value: value + 1, expiresAt: now + ttlSeconds * 1000 };
    save();
    return false;
  }

  function spendBudget(tokens) {
    if (!tokens) return;
    const day = today();
    state.budget[day] = (state.budget[day] || 0) + tokens;
    save();
  }

  function budgetExhausted(limit) {
    return (state.budget[today()] || 0) >= limit;
  }

  function spentToday() {
    return state.budget[today()] || 0;
  }

  /** Drops counters that expired and budget days older than a week. */
  function prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(state.counters)) {
      if (!v || v.expiresAt < now) delete state.counters[k];
    }
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    for (const day of Object.keys(state.budget)) {
      if (day < cutoff) delete state.budget[day];
    }
    save();
  }

  return { overLimit, spendBudget, budgetExhausted, spentToday, prune };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function thisHour() {
  return new Date().toISOString().slice(0, 13);
}
