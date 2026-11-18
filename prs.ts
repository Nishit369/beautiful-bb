// The PRs card's data: the user's open pull requests as the shared cache
// (pr-cache.ts) holds GitHub's search, reduced to what one sidebar row shows,
// and ordered so the ones that need the user come first. Pure, so the server
// and the card share it.
import { z } from "zod";

const countsSchema = z.array(z.object({ state: z.string(), count: z.number() }));
const searchNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  repository: z.object({ name: z.string(), nameWithOwner: z.string(), owner: z.object({ avatarUrl: z.string() }) }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  reviewDecision: z.string().nullable(),
  mergeable: z.string(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              state: z.string(),
              contexts: z.object({ checkRunCountsByState: countsSchema, statusContextCountsByState: countsSchema }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});
/** `gh api graphql` output; `is:pr` keeps every search node a pull request. */
const searchResponseSchema = z.object({
  data: z.object({ search: z.object({ nodes: z.array(searchNodeSchema) }) }),
});
type SearchNode = z.infer<typeof searchNodeSchema>;

export const CI_STATES = ["failing", "running", "passing", "none"] as const;
export const REVIEW_STATES = ["approved", "changes", "pending", "none"] as const;
export const MERGE_STATES = ["clean", "conflicts", "unknown"] as const;

const checksSchema = z.object({ passed: z.number(), failed: z.number(), running: z.number() });
export const pullRequestSchema = z.object({
  url: z.string(),
  /** owner/name */
  repo: z.string(),
  /** The repository name alone, the row's tag. */
  tag: z.string(),
  /** The repository owner's GitHub avatar: the org logo or the user's picture. */
  ownerAvatar: z.string(),
  number: z.number(),
  title: z.string(),
  draft: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  /** A size label such as "size/m", if the repo labels PR sizes. */
  size: z.string().nullable(),
  ci: z.enum(CI_STATES),
  checks: checksSchema,
  review: z.enum(REVIEW_STATES),
  merge: z.enum(MERGE_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type Checks = z.infer<typeof checksSchema>;

export const PROBLEMS = ["rate-limited", "no-gh", "signed-out", "error"] as const;

export const prsResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    prs: z.array(pullRequestSchema),
    /** When GitHub returned this list. */
    observedAt: z.number(),
    /** Why the last refresh failed, if it did; the list is then the last good one. */
    problem: z.enum(PROBLEMS).nullable(),
    /** When the next refresh may call GitHub, while a problem holds it back. */
    retryAt: z.number().nullable(),
  }),
  /** No list yet: another refresh is running, or GitHub can't be read (one quiet line). */
  z.object({ status: z.enum(["pending", ...PROBLEMS]) }),
]);
export type PrsResult = z.infer<typeof prsResultSchema>;

const CI: Record<string, PullRequest["ci"]> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "running",
  EXPECTED: "running",
};
const REVIEW: Record<string, PullRequest["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "pending",
};
const MERGE: Record<string, PullRequest["merge"]> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };

/** Check run and commit status states, by the bucket the hover summary counts them in. */
const CHECK_BUCKET: Record<string, keyof Checks> = {
  SUCCESS: "passed",
  NEUTRAL: "passed",
  SKIPPED: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  TIMED_OUT: "failed",
  CANCELLED: "failed",
  STARTUP_FAILURE: "failed",
  ACTION_REQUIRED: "failed",
  PENDING: "running",
  EXPECTED: "running",
  QUEUED: "running",
  IN_PROGRESS: "running",
  WAITING: "running",
};

const SIZE_LABEL = /^size[/:-]/i;

function toPullRequest(node: SearchNode): PullRequest {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks: Checks = { passed: 0, failed: 0, running: 0 };
  for (const { state, count } of [
    ...(rollup?.contexts.checkRunCountsByState ?? []),
    ...(rollup?.contexts.statusContextCountsByState ?? []),
  ]) {
    const bucket = CHECK_BUCKET[state];
    if (bucket) checks[bucket] += count;
  }
  return {
    url: node.url,
    repo: node.repository.nameWithOwner,
    tag: node.repository.name,
    ownerAvatar: node.repository.owner.avatarUrl,
    number: node.number,
    title: node.title,
    draft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    size: node.labels.nodes.find((l) => SIZE_LABEL.test(l.name))?.name ?? null,
    ci: (rollup && CI[rollup.state]) || "none",
    checks,
    review: (node.reviewDecision && REVIEW[node.reviewDecision]) || "none",
    merge: MERGE[node.mergeable] ?? "unknown",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * How much a PR needs the user, lowest first: red CI, then conflicts or
 * requested changes, then approved and green (ready to merge), then CI still
 * running, then waiting on review. Drafts sit below every ready-for-review PR.
 */
export function attention(pr: PullRequest): number {
  const rank =
    pr.ci === "failing"
      ? 0
      : pr.merge === "conflicts" || pr.review === "changes"
        ? 1
        : readyToMerge(pr)
          ? 2
          : pr.ci === "running"
            ? 3
            : 4;
  return pr.draft ? rank + 5 : rank;
}

export function byAttention(a: PullRequest, b: PullRequest): number {
  return attention(a) - attention(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Every pull request in a `gh api graphql` search response, most urgent first. */
export function parsePullRequests(json: unknown): PullRequest[] {
  return searchResponseSchema.parse(json).data.search.nodes.map(toPullRequest).sort(byAttention);
}

/** Approved, mergeable, CI green or absent, and out of draft. */
export function readyToMerge(pr: PullRequest): boolean {
  return !pr.draft && pr.review === "approved" && pr.merge === "clean" && (pr.ci === "passing" || pr.ci === "none");
}

/** The collapsed header's counts: red CI, PRs blocked on the user (conflicts or requested changes), and PRs ready to merge. */
export function summarize(prs: readonly PullRequest[]): { failing: number; blocked: number; ready: number } {
  let failing = 0;
  let blocked = 0;
  let ready = 0;
  for (const pr of prs) {
    if (pr.ci === "failing") failing++;
    else if (pr.merge === "conflicts" || pr.review === "changes") blocked++;
    else if (readyToMerge(pr)) ready++;
  }
  return { failing, blocked, ready };
}

export type Status = "failing" | "conflicts" | "changes" | "running" | "ready" | "approved" | "draft" | "open";

/** The one word a row's second line shows: the most pressing thing about the PR. */
export function status(pr: PullRequest): Status {
  if (pr.ci === "failing") return "failing";
  if (pr.merge === "conflicts") return "conflicts";
  if (pr.review === "changes") return "changes";
  if (pr.draft) return "draft";
  if (pr.ci === "running") return "running";
  if (readyToMerge(pr)) return "ready";
  if (pr.review === "approved") return "approved";
  return "open";
}

/** Failing CI, conflicts, or requested changes: the user has to act. */
export function needsAttention(pr: PullRequest): boolean {
  return pr.ci === "failing" || pr.merge === "conflicts" || pr.review === "changes";
}

/** At most one repo and one state at a time; null means any. */
export type PrFilter = { repo: string | null; state: "attention" | "ready" | null };
export const NO_FILTER: PrFilter = { repo: null, state: null };

const STATE_TEST = { attention: needsAttention, ready: readyToMerge } as const;

function matches(pr: PullRequest, { repo, state }: PrFilter): boolean {
  return (repo === null || pr.repo === repo) && (state === null || STATE_TEST[state](pr));
}

export function applyFilter(prs: readonly PullRequest[], filter: PrFilter): PullRequest[] {
  return prs.filter((pr) => matches(pr, filter));
}

/**
 * The filter chips and their counts. Each state chip counts within the chosen
 * repo, and each repo chip within the chosen state, so a count is what picking
 * that chip would show. Repos with the most PRs come first.
 */
export function filterChips(prs: readonly PullRequest[], filter: PrFilter) {
  const inRepo = applyFilter(prs, { ...filter, state: null });
  const repos = new Map<string, { repo: string; tag: string; avatar: string; count: number }>();
  for (const pr of prs) {
    const chip = repos.get(pr.repo) ?? { repo: pr.repo, tag: pr.tag, avatar: pr.ownerAvatar, count: 0 };
    if (matches(pr, { ...filter, repo: null })) chip.count++;
    repos.set(pr.repo, chip);
  }
  return {
    attention: inRepo.filter(needsAttention).length,
    ready: inRepo.filter(readyToMerge).length,
    repos: [...repos.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

/** A stored filter whose repo has no open PRs anymore falls back to any repo. */
export function liveFilter(prs: readonly PullRequest[], filter: PrFilter): PrFilter {
  return filter.repo && !prs.some((pr) => pr.repo === filter.repo) ? { ...filter, repo: null } : filter;
}

/** "3 passed, 1 failed, 2 running", or "No checks". */
export function checksSummary({ passed, failed, running }: Checks): string {
  const parts = [
    failed && `${failed} failed`,
    running && `${running} running`,
    passed && `${passed} passed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "No checks";
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "40m", "5h", "3d". */
export function age(since: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(since));
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}
