import assert from "node:assert/strict";
import test from "node:test";
import { accessToken, parseCredits } from "./credits.ts";

const usage = (extra) => ({ five_hour: { utilization: 12 }, extra_usage: extra });

test("credits show the amount spent against the monthly limit, in cents", () => {
  assert.deepEqual(
    parseCredits(usage({ is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: "usd" })),
    { usedCents: 1240, limitCents: 5000, currency: "USD", enabled: true },
  );
});

test("an unlimited monthly limit has no limit; a missing currency is USD", () => {
  assert.deepEqual(parseCredits(usage({ is_enabled: true, monthly_limit: null, used_credits: 300 })), {
    usedCents: 300,
    limitCents: null,
    currency: "USD",
    enabled: true,
  });
});

test("accounts without credits, or with credits off and nothing spent, show none", () => {
  assert.equal(parseCredits({ five_hour: null }), null);
  assert.equal(parseCredits(usage(null)), null);
  assert.equal(parseCredits(usage({ is_enabled: false, monthly_limit: 5000, used_credits: 0 })), null);
  assert.equal(parseCredits("not json"), null);
});

test("credits switched off after spending still show what was spent", () => {
  assert.deepEqual(parseCredits(usage({ is_enabled: false, monthly_limit: 5000, used_credits: 5000 })), {
    usedCents: 5000,
    limitCents: 5000,
    currency: "USD",
    enabled: false,
  });
});

test("an expired or malformed sign-in gives no token", () => {
  const signIn = (expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt } });
  assert.equal(accessToken(signIn(2000), 1000), "token", "a live sign-in gives its token");
  assert.equal(accessToken(signIn(null), 1000), "token", "a sign-in without an expiry gives its token");
  assert.equal(accessToken(signIn(1000), 1000), null, "an expired sign-in gives none");
  assert.equal(accessToken("{", 1000), null, "malformed JSON gives none");
  assert.equal(accessToken(JSON.stringify({}), 1000), null, "no Claude sign-in gives none");
  assert.equal(accessToken(null, 1000), null, "no credentials give none");
});
