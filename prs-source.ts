// Fetches the PRs card's data through the user's own `gh` CLI, so its existing
// sign-in does the auth and no token passes through the plugin. Read-only: one
// GraphQL search. Results are cached briefly, concurrent callers share one
// call, and a rate limit backs off for minutes, since GitHub's limits are per
// user and shared with every other tool. Also opens a PR in the system's
// default browser, which bb's own URL opener does not: it prefers bb's
// built-in browser.
import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { promisify } from "node:util";
import { PRS_QUERY, PRS_SEARCH, parsePullRequests, type PrsResult } from "./prs";

const TTL_MS = 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
/** bb launched from the Dock gets a bare PATH; look where Homebrew installs gh too. */
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);

type Warn = (message: string) => void;
type Fetched = { result: PrsResult; retryInMs: number };

let cached: { until: number; result: PrsResult } | null = null;
let lastOk: PrsResult | null = null;
let inFlight: Promise<PrsResult> | null = null;

async function fetchPullRequests(warn: Warn): Promise<Fetched> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["api", "graphql", "-f", `query=${PRS_QUERY}`, "-f", `q=${PRS_SEARCH}`], {
      timeout: 15_000,
      env: { ...process.env, PATH, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    lastOk = { status: "ok", prs: parsePullRequests(JSON.parse(stdout)), observedAt: Date.now() };
    return { result: lastOk, retryInMs: TTL_MS };
  } catch (error) {
    const e = error as { code?: string | number; stderr?: string; message?: string };
    if (e.code === "ENOENT") return { result: { status: "no-gh" }, retryInMs: TTL_MS };
    // gh exits 4 when it needs `gh auth login`.
    if (e.code === 4 || /gh auth login/.test(e.stderr ?? "")) return { result: { status: "signed-out" }, retryInMs: TTL_MS };
    // gh's stderr names the failure (network, rate limit, GraphQL error); it never contains the token.
    const detail = (e.stderr || e.message || "").trim().slice(0, 300);
    warn(`PR fetch failed (${e.code ?? "no code"}): ${detail}`);
    if (/rate limit/i.test(detail)) return { result: lastOk ?? { status: "rate-limited" }, retryInMs: RATE_LIMIT_BACKOFF_MS };
    return { result: lastOk ?? { status: "error" }, retryInMs: TTL_MS };
  }
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const OPENER: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", linux: "xdg-open" };

/** Opens a GitHub PR URL in the default browser; false if the URL or platform isn't supported. */
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = OPENER[process.platform];
  if (!opener || !PR_URL.test(url)) return false;
  try {
    await promisify(execFile)(opener, [url], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function myPullRequests(warn: Warn): Promise<PrsResult> {
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.result);
  inFlight ??= fetchPullRequests(warn)
    .then(({ result, retryInMs }) => {
      cached = { until: Date.now() + retryInMs, result };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
