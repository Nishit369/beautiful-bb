// Per-account history for the usage card's mini graph. Neither the providers
// nor the Account Pooler keep per-account history, and local token logs cannot
// tell a provider's accounts apart, so each refresh records the account's
// weekly-limit reading and a day's growth in that limit is the account's own
// bar. Until an account has that, its row falls back to provider-wide tokens.
import { z } from "zod";

const KEEP_DAYS = 8;
const GRAPH_DAYS = 7;
/** Providers report a window's reset time with jitter; a move this large means a new window. */
const SAME_WINDOW_MS = 60 * 60 * 1000;

const dayReadingSchema = z.object({
  /** Local calendar day, YYYY-MM-DD. */
  day: z.string(),
  /** The day's latest weekly-limit reading. */
  usedPercent: z.number(),
  resetsAt: z.number(),
  /** Percentage points the weekly limit grew on this day. */
  gain: z.number(),
});
const usageHistorySchema = z.object({
  /** The first day this account was recorded. */
  since: z.string(),
  /** Oldest first, at most KEEP_DAYS. */
  days: z.array(dayReadingSchema),
});
export type UsageHistory = z.infer<typeof usageHistorySchema>;

export interface LimitReading {
  usedPercent: number;
  resetsAt: number;
}

export const dayBarSchema = z
  .object({
    amount: z.number(),
    unit: z.enum(["percent", "tokens"]),
    /** Provider-wide activity standing in for an account with no history for the day. */
    shared: z.boolean(),
  })
  .nullable();
export type DayBar = z.infer<typeof dayBarSchema>;

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function recordReading(history: UsageHistory | undefined, reading: LimitReading, now: number): UsageHistory {
  const today = dayKey(new Date(now));
  const last = history?.days.at(-1);
  const gain = !last
    ? 0
    : Math.abs(reading.resetsAt - last.resetsAt) < SAME_WINDOW_MS
      ? Math.max(0, reading.usedPercent - last.usedPercent)
      : reading.usedPercent;
  const sameDay = last?.day === today;
  const earlier = (history?.days ?? []).slice(0, sameDay ? -1 : undefined);
  return {
    since: history?.since ?? today,
    days: [...earlier, { day: today, ...reading, gain: (sameDay ? last.gain : 0) + gain }].slice(-KEEP_DAYS),
  };
}

export function dailyGains(history: UsageHistory, now: number): (number | null)[] {
  const today = new Date(now);
  return Array.from({ length: GRAPH_DAYS }, (_, i) => {
    const day = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (GRAPH_DAYS - 1 - i)));
    // The first day only counts from the first reading, so it is not a whole day's growth.
    if (day === history.since) return null;
    return history.days.find((reading) => reading.day === day)?.gain ?? null;
  });
}

interface HistoryStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Records this refresh's reading for one account and returns its history. */
export async function trackUsage(
  kv: HistoryStore,
  account: { id: string; providerId: string; accountKey: string | null; usedPercent: number; resetsAt: string },
  now: number,
): Promise<UsageHistory> {
  const key = `usage-history:${account.providerId}:${account.accountKey ?? account.id}`;
  const stored = usageHistorySchema.safeParse(await kv.get(key));
  const history = recordReading(
    stored.success ? stored.data : undefined,
    { usedPercent: account.usedPercent, resetsAt: Date.parse(account.resetsAt) },
    now,
  );
  await kv.set(key, history);
  return history;
}

/**
 * A provider's only account owns all of the provider's local tokens. With
 * several accounts, a day the account has its own growth for shows that, and
 * any other day shows the provider-wide tokens, marked shared.
 */
export function dayBars(gains: (number | null)[], tokens: number[], sharedProvider: boolean): DayBar[] {
  return gains.map((gain, i) => {
    const dayTokens = tokens[tokens.length - gains.length + i];
    if (sharedProvider && gain !== null) return { amount: gain, unit: "percent", shared: false };
    return dayTokens === undefined ? null : { amount: dayTokens, unit: "tokens", shared: sharedProvider };
  });
}
