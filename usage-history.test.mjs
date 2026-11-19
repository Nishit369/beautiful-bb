import assert from "node:assert/strict";
import test from "node:test";
import { until } from "./duration.ts";
import { dailyGains, recordReading, trackUsage } from "./usage-history.ts";

const HOUR = 60 * 60 * 1000;
const at = (day, hour = 12) => new Date(2026, 10, day, hour).getTime();
const resetsAt = at(25);

function memoryKv() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => structuredClone(rows.get(key)),
    set: async (key, value) => void rows.set(key, structuredClone(value)),
  };
}

const replay = (readings) =>
  readings.reduce((history, [now, usedPercent, resets = resetsAt]) => recordReading(history, { usedPercent, resetsAt: resets }, now), undefined);

test("the first reading starts history without inventing earlier usage", () => {
  const history = replay([[at(19), 15]]);
  assert.equal(history.since, "2026-11-19");
  assert.deepEqual(dailyGains(history, at(19)), [null, null, null, null, null, null, 0]);
});

test("each day's bar is how far the weekly limit grew that day", () => {
  const history = replay([
    [at(17, 9), 10],
    [at(17, 20), 14],
    [at(18, 10), 14],
    [at(18, 22), 21],
    [at(19, 8), 25],
  ]);
  assert.deepEqual(dailyGains(history, at(19, 9)), [null, null, null, null, 4, 7, 4]);
});

test("a day with no reading stays empty and its usage lands on the next reading", () => {
  const history = replay([[at(16), 10], [at(18), 16]]);
  assert.deepEqual(dailyGains(history, at(18)), [null, null, null, null, 0, null, 6]);
});

test("a new weekly window counts its usage from zero; reset-time jitter does not", () => {
  const history = replay([
    [at(18, 10), 90],
    [at(18, 11), 92, resetsAt + 30_000],
    [at(19, 9), 3, resetsAt + 7 * 24 * HOUR],
  ]);
  assert.deepEqual(dailyGains(history, at(19, 10)).slice(-2), [2, 3]);
});

test("history keeps eight days and the graph shows the last seven", () => {
  const history = replay(Array.from({ length: 12 }, (_, i) => [at(8 + i), i * 2]));
  assert.equal(history.days.length, 8);
  assert.equal(history.since, "2026-11-08");
  assert.deepEqual(dailyGains(history, at(19)), [2, 2, 2, 2, 2, 2, 2]);
});

test("each account keeps its own history, and the same account keeps it when it moves into the pool", async () => {
  const kv = memoryKv();
  const local = { id: "claude-code", providerId: "claude-code", accountKey: "anthropic:a", resetsAt: new Date(resetsAt).toISOString() };
  const pooled = { ...local, id: "account-pool:x" };
  const other = { ...local, id: "account-pool:y", accountKey: "anthropic:b" };
  await trackUsage(kv, { ...local, usedPercent: 5 }, at(19, 9));
  await trackUsage(kv, { ...other, usedPercent: 40 }, at(19, 9));
  const moved = await trackUsage(kv, { ...pooled, usedPercent: 8 }, at(19, 10));
  const untouched = await trackUsage(kv, { ...other, usedPercent: 40 }, at(19, 10));
  assert.deepEqual(moved, { daily: [null, null, null, null, null, null, 3], historySince: "2026-11-19" });
  assert.equal(untouched.daily.at(-1), 0);
  assert.equal(kv.rows.size, 2);
});

test("unreadable stored history starts over instead of failing the card", async () => {
  const kv = memoryKv();
  kv.rows.set("usage-history:codex:codex", { days: "corrupt" });
  const series = await trackUsage(kv, { id: "codex", providerId: "codex", accountKey: null, usedPercent: 9, resetsAt: new Date(resetsAt).toISOString() }, at(19));
  assert.deepEqual(series.daily.at(-1), 0);
});

test("reset labels roll over instead of showing 60m or 24h", () => {
  assert.equal(until(30 * 1000), "1m");
  assert.equal(until(59.7 * 60 * 1000), "1h");
  assert.equal(until(23.6 * HOUR), "1d");
  assert.equal(until(47.6 * HOUR), "2d");
  assert.equal(until(24 * HOUR + 23.6 * HOUR), "2d");
  assert.equal(until(2 * 24 * HOUR + 3.2 * HOUR), "2d 3h");
  assert.equal(until(5 * HOUR), "5h");
});
