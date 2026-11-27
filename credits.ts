// Claude's usage credits (extra usage): money spent past the plan's limits this
// month. bb's usage API leaves them out, so this reads them the way Claude Code
// does, from the usage endpoint with Claude Code's own sign-in. It never
// refreshes the sign-in; while it is expired the card keeps the last reading.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export const creditsSchema = z
  .object({
    /** Minor units of `currency` (cents for USD), as the API reports them. */
    usedCents: z.number(),
    /** Null when the monthly limit is unlimited. */
    limitCents: z.number().nullable(),
    currency: z.string(),
    enabled: z.boolean(),
  })
  .nullable();
export type Credits = z.infer<typeof creditsSchema>;

const usageSchema = z.object({
  extra_usage: z
    .object({
      is_enabled: z.boolean(),
      monthly_limit: z.number().nullish(),
      used_credits: z.number().nullish(),
      currency: z.string().nullish(),
    })
    .nullish(),
});

const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1), expiresAt: z.number().nullish() }),
});

/** Credits from a usage reply, or null when the account has none to show. */
export function parseCredits(body: unknown): Credits {
  const parsed = usageSchema.safeParse(body);
  const extra = parsed.success ? parsed.data.extra_usage : null;
  if (!extra) return null;
  const usedCents = extra.used_credits ?? 0;
  if (!extra.is_enabled && usedCents === 0) return null;
  return {
    usedCents,
    limitCents: extra.monthly_limit ?? null,
    currency: (extra.currency ?? "USD").toUpperCase(),
    enabled: extra.is_enabled,
  };
}

async function readCredentials(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await promisify(execFile)(
        "security",
        ["find-generic-password", "-a", userInfo().username, "-w", "-s", KEYCHAIN_SERVICE],
        { timeout: 5000 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Not in the keychain; try the file below.
    }
  }
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return readFile(join(dir, ".credentials.json"), "utf8").catch(() => null);
}

/** A usable Claude Code access token, or null when signed out or expired. */
export function accessToken(raw: string | null, now: number): string | null {
  if (!raw) return null;
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { accessToken, expiresAt } = parsed.data.claudeAiOauth;
    return expiresAt && expiresAt <= now ? null : accessToken;
  } catch {
    return null;
  }
}

export async function claudeCredits(now = Date.now()): Promise<Credits> {
  const raw = await readCredentials();
  if (!raw) throw new Error("no Claude Code sign-in found");
  const token = accessToken(raw, now);
  if (!token) throw new Error("the Claude Code sign-in is expired or unreadable");
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const reason = await res.text().then((text) => text.slice(0, 200), () => "");
    throw new Error(`Claude usage returned ${res.status} ${reason}`.trim());
  }
  return parseCredits(await res.json());
}
