// The open-PR cache shared by every bb plugin that shows the user's pull
// requests (this card and bb-armada's Crew tab), so they make one GitHub
// search between them, at most every five minutes. Format v1: one JSON file
// under ~/.cache/bb-prs, written by temp file and rename, with a lockfile so
// only one fetch runs at a time. A rate limit or failure sets nextAllowedAt,
// which every reader honors, and never clears the last good data.
// Self-contained (gh runner, clock and directory are passed in) so other
// plugins can copy it and tests can drive it.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CACHE_VERSION = 1;
export const SEARCH = "is:pr is:open author:@me archived:false sort:updated-desc";
export const FRESH_MS = 5 * 60 * 1000;
const STALE_LOCK_MS = 60 * 1000;
const MINUTE = 60 * 1000;

/** Both plugins send exactly this query; a new field means a version bump for both. */
export const QUERY = `query($q: String!) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest {
      number title url isDraft createdAt updatedAt additions deletions headRefName baseRefName
      author { login }
      repository { name nameWithOwner owner { login avatarUrl(size: 32) } }
      labels(first: 20) { nodes { name } }
      reviewDecision mergeable
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
        checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
    } }
  }
}`;

export type ErrorKind = "rate-limited" | "no-gh" | "signed-out" | "error";

export type CacheFile = {
  version: typeof CACHE_VERSION;
  search: string;
  fetchedAt: number | null;
  nextAllowedAt: number;
  failures: number;
  lastError: { at: number; kind: ErrorKind; message: string } | null;
  /** GitHub's response `data`, exactly as returned. */
  data: unknown;
};

export type GhResult = { code: number | string; stdout: string; stderr: string };
export type CacheDeps = {
  dir: string;
  now: () => number;
  /** Runs gh with these arguments; resolves with its exit code instead of throwing. */
  gh: (args: string[]) => Promise<GhResult>;
};

const EMPTY: CacheFile = {
  version: CACHE_VERSION,
  search: SEARCH,
  fetchedAt: null,
  nextAllowedAt: 0,
  failures: 0,
  lastError: null,
  data: null,
};

const cachePath = (dir: string) => join(dir, "open-prs.json");
const lockPath = (dir: string) => join(dir, "open-prs.lock");

/** The cache as this version understands it; a missing, broken or newer file reads as empty. */
export async function readCache(dir: string): Promise<CacheFile & { foreign: boolean }> {
  try {
    const file = JSON.parse(await readFile(cachePath(dir), "utf8"));
    if (typeof file?.version === "number" && file.version > CACHE_VERSION) return { ...EMPTY, foreign: true };
    if (file?.version !== CACHE_VERSION || file.search !== SEARCH) return { ...EMPTY, foreign: false };
    return { ...EMPTY, ...file, foreign: false };
  } catch {
    return { ...EMPTY, foreign: false };
  }
}

export function isFresh(cache: CacheFile, now: number): boolean {
  return cache.fetchedAt !== null && now - cache.fetchedAt < FRESH_MS;
}

/** Whether a caller may hit GitHub now: the data is stale and no backoff is pending. */
export function mayFetch(cache: CacheFile, now: number): boolean {
  return !isFresh(cache, now) && now >= cache.nextAllowedAt;
}

async function writeCache(dir: string, { version, search, fetchedAt, nextAllowedAt, failures, lastError, data }: CacheFile) {
  const tmp = join(dir, `open-prs.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const file: CacheFile = { version, search, fetchedAt, nextAllowedAt, failures, lastError, data };
  await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
  await rename(tmp, cachePath(dir));
}

/**
 * When the lock was taken: its `at`, or the file's mtime when that is missing
 * or unreadable (open "wx" creates the file empty, before `{pid, at}` lands).
 */
async function lockTakenAt(dir: string): Promise<number> {
  const at = await readFile(lockPath(dir), "utf8")
    .then((text) => Number(JSON.parse(text).at))
    .catch(() => NaN);
  if (Number.isFinite(at)) return at;
  return (await stat(lockPath(dir)).catch(() => null))?.mtimeMs ?? 0;
}

/** Takes the fetch lock, or returns null when another fetch holds a live one. */
async function takeLock(dir: string, now: number): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath(dir), "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now }));
      await handle.close();
      return () => unlink(lockPath(dir)).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const heldSince = await lockTakenAt(dir);
      if (!(now - heldSince > STALE_LOCK_MS)) return null;
      await unlink(lockPath(dir)).catch(() => {});
    }
  }
  return null;
}

type HttpResponse = { status: number | null; headers: Record<string, string>; body: any };

/** Splits `gh api --include` output into status, lowercased headers and the parsed JSON body. */
export function parseIncluded(stdout: string): HttpResponse {
  const split = stdout.search(/\r?\n\r?\n/);
  const head = split === -1 ? "" : stdout.slice(0, split);
  const rest = split === -1 ? stdout : stdout.slice(split).trim();
  const [statusLine = "", ...lines] = head.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body: any = null;
  try {
    body = JSON.parse(rest);
  } catch {
    // Not JSON (an HTML error page, or nothing at all).
  }
  return { status: Number(statusLine.split(" ")[1]) || null, headers, body };
}

function isRateLimited(res: HttpResponse, stderr: string): boolean {
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(JSON.stringify(res.body ?? "") + stderr))) return true;
  if (Array.isArray(res.body?.errors) && res.body.errors.some((e: any) => /^RATE_LIMIT/.test(String(e?.type ?? "")))) return true;
  return /rate limit/i.test(stderr);
}

/** When GitHub will take requests again, from the response or one rate_limit call; null when it doesn't say. */
async function rateLimitResetsAt(res: HttpResponse, deps: CacheDeps): Promise<number | null> {
  const now = deps.now();
  const retryAfter = Number(res.headers["retry-after"]);
  if (retryAfter > 0) return now + retryAfter * 1000;
  const reset = Number(res.headers["x-ratelimit-reset"]);
  if (res.headers["x-ratelimit-remaining"] === "0" && reset > 0) return reset * 1000;
  const limits = await deps.gh(["api", "rate_limit"]);
  if (limits.code !== 0) return null;
  try {
    const graphql = JSON.parse(limits.stdout)?.resources?.graphql;
    return graphql?.remaining === 0 && graphql.reset > 0 ? graphql.reset * 1000 : null;
  } catch {
    return null;
  }
}

const backoff = (base: number, failures: number, cap: number) => Math.min(base * 2 ** failures, cap);

/** Fetches once and folds the outcome into the cache, keeping the last good data on failure. */
async function fetchInto(cache: CacheFile, deps: CacheDeps): Promise<CacheFile> {
  const run = await deps.gh(["api", "graphql", "--include", "-f", `query=${QUERY}`, "-f", `q=${SEARCH}`]);
  const now = deps.now();
  const res = parseIncluded(run.stdout);
  if (run.code === 0 && res.body?.data?.search) {
    return { ...cache, fetchedAt: now, nextAllowedAt: now + FRESH_MS, failures: 0, lastError: null, data: res.body.data };
  }
  // gh's stderr names the failure; it never contains the token.
  const message = (run.stderr || run.stdout).trim().slice(0, 300);
  const fail = (kind: ErrorKind, nextAllowedAt: number): CacheFile => ({
    ...cache,
    nextAllowedAt,
    failures: cache.failures + 1,
    lastError: { at: now, kind, message },
  });
  if (run.code === "ENOENT") return fail("no-gh", now + FRESH_MS);
  if (run.code === 4 || /gh auth login/.test(run.stderr)) return fail("signed-out", now + FRESH_MS);
  if (isRateLimited(res, run.stderr)) {
    const resetsAt = await rateLimitResetsAt(res, deps);
    return fail("rate-limited", resetsAt ?? now + backoff(5 * MINUTE, cache.failures, 60 * MINUTE));
  }
  return fail("error", now + backoff(MINUTE, cache.failures, 30 * MINUTE));
}

/**
 * The shared cache, fetching first only when it is stale, no backoff is
 * pending and this caller wins the lock. Losing the lock or a backoff never
 * waits: the caller gets whatever the cache holds.
 */
export async function refreshOpenPrs(deps: CacheDeps): Promise<CacheFile> {
  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  const before = await readCache(deps.dir);
  if (before.foreign || !mayFetch(before, deps.now())) return before;
  const release = await takeLock(deps.dir, deps.now());
  if (!release) return before;
  try {
    // Another process may have fetched between the first read and the lock.
    const current = await readCache(deps.dir);
    if (!mayFetch(current, deps.now())) return current;
    const next = await fetchInto(current, deps);
    await writeCache(deps.dir, next);
    return next;
  } finally {
    await release();
  }
}
