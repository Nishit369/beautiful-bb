import assert from "node:assert/strict";
import test from "node:test";
import { age, applyFilter, checksSummary, filterChips, liveFilter, parsePullRequests, status, summarize } from "./prs.ts";

const counts = (byState) => Object.entries(byState).map(([state, count]) => ({ state, count }));

/** One search node in the shape `gh api graphql` returns for PRS_QUERY. */
function node({
  number,
  repo = "productstudioinc/cops",
  draft = false,
  review = null,
  mergeable = "MERGEABLE",
  rollup = "SUCCESS",
  runs = { SUCCESS: 2, NEUTRAL: 1 },
  statuses = {},
  updatedAt = "2026-11-18T10:00:00Z",
  labels = [],
}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: draft,
    createdAt: "2026-11-17T10:00:00Z",
    updatedAt,
    additions: 559,
    deletions: 1,
    repository: { name: repo.split("/")[1], nameWithOwner: repo, owner: { avatarUrl: `https://avatars.example/${repo.split("/")[0]}` } },
    labels: { nodes: labels.map((name) => ({ name })) },
    reviewDecision: review,
    mergeable,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup:
              rollup === null
                ? null
                : {
                    state: rollup,
                    contexts: { checkRunCountsByState: counts(runs), statusContextCountsByState: counts(statuses) },
                  },
          },
        },
      ],
    },
  };
}

const response = (...nodes) => ({ data: { search: { nodes } } });
const numbers = (prs) => prs.map((pr) => pr.number);

test("maps GitHub's CI, review and merge states to the row's states", () => {
  const [failing, running, passing, none] = parsePullRequests(
    response(
      node({ number: 1, rollup: "FAILURE", runs: { FAILURE: 1, SUCCESS: 3 }, updatedAt: "2026-11-18T04:00:00Z" }),
      node({ number: 2, rollup: "PENDING", runs: { IN_PROGRESS: 2, QUEUED: 1 }, updatedAt: "2026-11-18T03:00:00Z" }),
      node({ number: 3, rollup: "SUCCESS", review: "REVIEW_REQUIRED", updatedAt: "2026-11-18T02:00:00Z" }),
      node({ number: 4, rollup: null, mergeable: "UNKNOWN", updatedAt: "2026-11-18T01:00:00Z" }),
    ),
  );
  assert.deepEqual(
    [failing, running, passing, none].map((pr) => [pr.number, pr.ci]),
    [
      [1, "failing"],
      [2, "running"],
      [3, "passing"],
      [4, "none"],
    ],
  );
  assert.equal(passing.review, "pending");
  assert.equal(none.review, "none");
  assert.equal(none.merge, "unknown");
  assert.deepEqual(failing.checks, { passed: 3, failed: 1, running: 0 });
  assert.deepEqual(running.checks, { passed: 0, failed: 0, running: 3 });
  assert.equal(failing.tag, "cops");
  assert.equal(failing.repo, "productstudioinc/cops");
});

test("an errored commit status fails CI and counts with the check runs", () => {
  const [pr] = parsePullRequests(
    response(node({ number: 1, rollup: "ERROR", runs: { SUCCESS: 2, SKIPPED: 1 }, statuses: { ERROR: 1, SUCCESS: 1 } })),
  );
  assert.equal(pr.ci, "failing");
  assert.deepEqual(pr.checks, { passed: 4, failed: 1, running: 0 });
});

test("orders failing CI, then conflicts or changes, then ready to merge, then running, then waiting, drafts last", () => {
  const prs = parsePullRequests(
    response(
      node({ number: 10, draft: true, rollup: "FAILURE" }),
      node({ number: 11 }),
      node({ number: 12, rollup: "PENDING" }),
      node({ number: 13, review: "APPROVED" }),
      node({ number: 14, review: "CHANGES_REQUESTED" }),
      node({ number: 15, mergeable: "CONFLICTING" }),
      node({ number: 16, rollup: "FAILURE", mergeable: "CONFLICTING" }),
    ),
  );
  assert.deepEqual(numbers(prs), [16, 14, 15, 13, 12, 11, 10]);
});

test("an approved PR whose CI is still running waits with the running ones", () => {
  const prs = parsePullRequests(
    response(node({ number: 1, review: "APPROVED", rollup: "PENDING" }), node({ number: 2, review: "APPROVED" })),
  );
  assert.deepEqual(numbers(prs), [2, 1]);
});

test("PRs that need the same thing show the most recently updated first", () => {
  const prs = parsePullRequests(
    response(
      node({ number: 1, updatedAt: "2026-11-17T10:00:00Z" }),
      node({ number: 2, updatedAt: "2026-11-19T10:00:00Z" }),
      node({ number: 3, updatedAt: "2026-11-18T10:00:00Z" }),
    ),
  );
  assert.deepEqual(numbers(prs), [2, 3, 1]);
});

test("the collapsed header counts each PR once: failing CI, then blocked, then ready to merge", () => {
  const prs = parsePullRequests(
    response(
      node({ number: 1, rollup: "FAILURE", mergeable: "CONFLICTING" }),
      node({ number: 2, rollup: "FAILURE" }),
      node({ number: 3, mergeable: "CONFLICTING", review: "APPROVED" }),
      node({ number: 4, review: "CHANGES_REQUESTED" }),
      node({ number: 5, review: "APPROVED" }),
      node({ number: 6, review: "APPROVED", rollup: null }),
      node({ number: 7, review: "APPROVED", rollup: "PENDING" }),
      node({ number: 8, review: "APPROVED", draft: true }),
      node({ number: 9, review: "APPROVED", mergeable: "UNKNOWN" }),
      node({ number: 10 }),
    ),
  );
  assert.deepEqual(summarize(prs), { failing: 2, blocked: 2, ready: 2 });
  assert.deepEqual(summarize([]), { failing: 0, blocked: 0, ready: 0 });
});

test("a row's status word is the most pressing thing about the PR", () => {
  const byNumber = Object.fromEntries(
    parsePullRequests(
      response(
        node({ number: 1, rollup: "FAILURE", mergeable: "CONFLICTING", draft: true }),
        node({ number: 2, mergeable: "CONFLICTING", review: "CHANGES_REQUESTED" }),
        node({ number: 3, review: "CHANGES_REQUESTED", draft: true }),
        node({ number: 4, draft: true, rollup: "PENDING" }),
        node({ number: 5, rollup: "PENDING", review: "APPROVED" }),
        node({ number: 6, review: "APPROVED" }),
        node({ number: 7, review: "APPROVED", mergeable: "UNKNOWN" }),
        node({ number: 8, review: "REVIEW_REQUIRED" }),
      ),
    ).map((pr) => [pr.number, status(pr)]),
  );
  assert.deepEqual(byNumber, {
    1: "failing",
    2: "conflicts",
    3: "changes",
    4: "draft",
    5: "running",
    6: "ready",
    7: "approved",
    8: "open",
  });
});

test("carries lines changed, the owner's avatar, and a size label when the repo has one", () => {
  const [sized, plain] = parsePullRequests(
    response(
      node({ number: 1, labels: ["bug", "size/m"], updatedAt: "2026-11-19T10:00:00Z" }),
      node({ number: 2, labels: ["bug"] }),
    ),
  );
  assert.equal(sized.size, "size/m");
  assert.equal(plain.size, null);
  assert.deepEqual([sized.additions, sized.deletions], [559, 1]);
  assert.equal(sized.ownerAvatar, "https://avatars.example/productstudioinc");
});

const mixed = () =>
  parsePullRequests(
    response(
      node({ number: 1, rollup: "FAILURE" }),
      node({ number: 2, mergeable: "CONFLICTING" }),
      node({ number: 3, review: "APPROVED" }),
      node({ number: 4 }),
      node({ number: 5, repo: "sankalpaacharya/gymside", review: "APPROVED" }),
      node({ number: 6, repo: "sankalpaacharya/gymside" }),
      node({ number: 7, repo: "productstudioinc/content", review: "CHANGES_REQUESTED" }),
    ),
  );

test("filters by one repo and one state together", () => {
  const prs = mixed();
  assert.deepEqual(numbers(applyFilter(prs, { repo: null, state: null })).length, 7);
  assert.deepEqual(numbers(applyFilter(prs, { repo: "productstudioinc/cops", state: null })).sort(), [1, 2, 3, 4]);
  assert.deepEqual(numbers(applyFilter(prs, { repo: null, state: "attention" })).sort(), [1, 2, 7]);
  assert.deepEqual(numbers(applyFilter(prs, { repo: null, state: "ready" })).sort(), [3, 5]);
  assert.deepEqual(numbers(applyFilter(prs, { repo: "sankalpaacharya/gymside", state: "ready" })), [5]);
});

test("each chip counts what picking it would show, given the other filter", () => {
  const prs = mixed();
  const any = filterChips(prs, { repo: null, state: null });
  assert.equal(any.attention, 3);
  assert.equal(any.ready, 2);
  assert.deepEqual(
    any.repos.map((r) => [r.tag, r.count]),
    [
      ["cops", 4],
      ["gymside", 2],
      ["content", 1],
    ],
  );
  const cops = filterChips(prs, { repo: "productstudioinc/cops", state: null });
  assert.deepEqual([cops.attention, cops.ready], [2, 1]);
  const ready = filterChips(prs, { repo: null, state: "ready" });
  assert.deepEqual(
    ready.repos.map((r) => [r.tag, r.count]),
    [
      ["cops", 1],
      ["gymside", 1],
      ["content", 0],
    ],
  );
});

test("a remembered repo filter with no open PRs left falls back to every repo", () => {
  const prs = mixed();
  assert.deepEqual(liveFilter(prs, { repo: "productstudioinc/portal", state: "ready" }), { repo: null, state: "ready" });
  assert.deepEqual(liveFilter(prs, { repo: "productstudioinc/cops", state: null }), { repo: "productstudioinc/cops", state: null });
});

test("hover details read as plain counts and ages", () => {
  assert.equal(checksSummary({ passed: 3, failed: 1, running: 2 }), "1 failed, 2 running, 3 passed");
  assert.equal(checksSummary({ passed: 0, failed: 0, running: 0 }), "No checks");
  const now = Date.parse("2026-11-19T12:00:00Z");
  assert.equal(age("2026-11-19T11:20:00Z", now), "40m");
  assert.equal(age("2026-11-19T07:00:00Z", now), "5h");
  assert.equal(age("2026-11-16T12:00:00Z", now), "3d");
});

test("rejects a response that is not a search result", () => {
  assert.throws(() => parsePullRequests({ errors: [{ message: "Bad credentials" }] }));
});
