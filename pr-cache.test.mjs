import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FRESH_MS, readCache, refreshOpenPrs } from "./pr-cache.ts";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-11-19T10:00:00Z");
const DATA = { rateLimit: { cost: 1 }, search: { issueCount: 1, nodes: [{ number: 1 }] } };
const ok = (data = DATA) => ({ code: 0, stdout: `HTTP/2.0 200 OK\nContent-Type: application/json\n\n${JSON.stringify({ data })}`, stderr: "" });
const rateLimited = (headers = "") => ({
  code: 1,
  stdout: `HTTP/2.0 200 OK\n${headers}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMIT", message: "API rate limit already exceeded" }] })}`,
  stderr: "gh: API rate limit already exceeded for user ID 1.",
});

/** A cache dir, a settable clock, and a fake gh that answers from a queue and records every call. */
async function setup(answers = []) {
  const dir = await mkdtemp(join(tmpdir(), "bb-prs-"));
  const clock = { now: T0 };
  const calls = [];
  const gh = async (args) => {
    calls.push(args[1]);
    const next = answers.shift();
    return typeof next === "function" ? next() : (next ?? ok());
  };
  return { dir, clock, calls, deps: { dir, now: () => clock.now, gh } };
}

test("a stale cache fetches once; a fresh one is served without calling GitHub", async () => {
  const { deps, clock, calls } = await setup();
  const first = await refreshOpenPrs(deps);
  assert.deepEqual(first.data, DATA);
  assert.equal(first.fetchedAt, T0);
  clock.now = T0 + FRESH_MS - 1;
  await refreshOpenPrs(deps);
  assert.deepEqual(calls, ["graphql"]);
  clock.now = T0 + FRESH_MS;
  await refreshOpenPrs(deps);
  assert.deepEqual(calls, ["graphql", "graphql"]);
});

test("concurrent callers make one GitHub call; the loser serves the cache instead of waiting", async () => {
  let finish;
  const slow = () => new Promise((resolve) => (finish = () => resolve(ok())));
  const { deps, calls } = await setup([slow]);
  const winner = refreshOpenPrs(deps);
  await new Promise((r) => setTimeout(r, 20));
  const loser = await refreshOpenPrs(deps);
  assert.equal(loser.data, null);
  finish();
  assert.deepEqual((await winner).data, DATA);
  assert.deepEqual(calls, ["graphql"]);
});

test("a live lock held by another process blocks fetching; a lock older than a minute is taken over", async () => {
  const { dir, deps, clock, calls } = await setup();
  await writeFile(join(dir, "open-prs.lock"), JSON.stringify({ pid: 1, at: T0 - 30 * 1000 }));
  assert.equal((await refreshOpenPrs(deps)).data, null);
  assert.deepEqual(calls, []);
  clock.now = T0 + 31 * 1000;
  assert.deepEqual((await refreshOpenPrs(deps)).data, DATA);
  assert.deepEqual(calls, ["graphql"]);
});

test("a lock still being written (empty file) counts as live by its file time, so no second search runs", async () => {
  const { dir, deps, clock, calls } = await setup();
  clock.now = Date.now();
  await writeFile(join(dir, "open-prs.lock"), "");
  assert.equal((await refreshOpenPrs(deps)).data, null);
  await writeFile(join(dir, "open-prs.lock"), "{}");
  assert.equal((await refreshOpenPrs(deps)).data, null);
  assert.deepEqual(calls, []);
  clock.now = Date.now() + 61 * 1000;
  assert.deepEqual((await refreshOpenPrs(deps)).data, DATA);
});

test("a rate limit waits for Retry-After, keeps the last data, and calls GitHub again only after it", async () => {
  const { deps, clock, calls } = await setup([ok(), rateLimited("Retry-After: 120"), ok()]);
  await refreshOpenPrs(deps);
  clock.now = T0 + FRESH_MS;
  const limited = await refreshOpenPrs(deps);
  assert.equal(limited.lastError.kind, "rate-limited");
  assert.deepEqual(limited.data, DATA);
  assert.equal(limited.nextAllowedAt, clock.now + 2 * MIN);
  clock.now += MIN;
  await refreshOpenPrs(deps);
  assert.deepEqual(calls, ["graphql", "graphql"]);
  clock.now += MIN;
  const recovered = await refreshOpenPrs(deps);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.failures, 0);
  assert.deepEqual(calls, ["graphql", "graphql", "graphql"]);
});

test("a rate limit with no reset in the response asks rate_limit once and waits for the GraphQL reset", async () => {
  const reset = Math.floor((T0 + 40 * MIN) / 1000);
  const limits = { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 0, reset } } }), stderr: "" };
  const { deps, calls } = await setup([rateLimited(), limits]);
  const limited = await refreshOpenPrs(deps);
  assert.deepEqual(calls, ["graphql", "rate_limit"]);
  assert.equal(limited.nextAllowedAt, reset * 1000);
});

test("the secondary limit (budget left, no reset given) backs off 5 minutes, doubling up to an hour", async () => {
  const limits = { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 3000, reset: 1 } } }), stderr: "" };
  const { deps, clock } = await setup([rateLimited(), limits, rateLimited(), limits]);
  const first = await refreshOpenPrs(deps);
  assert.equal(first.nextAllowedAt - clock.now, 5 * MIN);
  clock.now = first.nextAllowedAt;
  const second = await refreshOpenPrs(deps);
  assert.equal(second.nextAllowedAt - clock.now, 10 * MIN);
  assert.equal(second.failures, 2);
});

test("other failures back off a minute, doubling, and never clear the last data", async () => {
  const boom = { code: 1, stdout: "", stderr: "gh: connection reset" };
  const { deps, clock } = await setup([ok(), boom, boom]);
  await refreshOpenPrs(deps);
  clock.now = T0 + FRESH_MS;
  const first = await refreshOpenPrs(deps);
  assert.equal(first.nextAllowedAt - clock.now, MIN);
  clock.now = first.nextAllowedAt;
  const second = await refreshOpenPrs(deps);
  assert.equal(second.nextAllowedAt - clock.now, 2 * MIN);
  assert.equal(second.lastError.kind, "error");
  assert.deepEqual(second.data, DATA);
});

test("gh missing or signed out is recorded, and retried after five minutes", async () => {
  const { deps, clock } = await setup([{ code: "ENOENT", stdout: "", stderr: "" }]);
  const missing = await refreshOpenPrs(deps);
  assert.equal(missing.lastError.kind, "no-gh");
  assert.equal(missing.nextAllowedAt, clock.now + FRESH_MS);
  const signedOut = await setup([{ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login" }]);
  assert.equal((await refreshOpenPrs(signedOut.deps)).lastError.kind, "signed-out");
});

test("a cache written by a newer format version is left alone", async () => {
  const { dir, deps, calls } = await setup();
  const newer = JSON.stringify({ version: 2, search: "x", data: { other: true } });
  await writeFile(join(dir, "open-prs.json"), newer);
  const seen = await refreshOpenPrs(deps);
  assert.equal(seen.data, null);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(join(dir, "open-prs.json"), "utf8"), newer);
});

test("the file on disk holds exactly the v1 fields", async () => {
  const { dir, deps } = await setup();
  await refreshOpenPrs(deps);
  const file = JSON.parse(await readFile(join(dir, "open-prs.json"), "utf8"));
  assert.deepEqual(Object.keys(file).sort(), ["data", "failures", "fetchedAt", "lastError", "nextAllowedAt", "search", "version"]);
  assert.deepEqual((await readCache(dir)).data, DATA);
});
