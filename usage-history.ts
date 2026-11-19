// Per-account history for the usage card's mini graph. Neither the providers
// nor the Account Pooler keep per-account history, and local token logs cannot
// tell accounts apart, so each refresh records the account's weekly-limit
// reading and each day's bar is how far that limit grew on that day.
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

export interface UsageSeries {
  /** One entry per day, today last; null where no reading was taken. */
  daily: (number | null)[];
  /** The first recorded day, YYYY-MM-DD; null when history could not be read. */
  historySince: string | null;
}

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
    return history.days.find((reading) => reading.day === day)?.gain ?? null;
  });
}

interface HistoryStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Records this refresh's reading for one account and returns its 7-day series. */
export async function trackUsage(
  kv: HistoryStore,
  account: { id: string; providerId: string; accountKey: string | null; usedPercent: number; resetsAt: string },
  now: number,
): Promise<UsageSeries> {
  const key = `usage-history:${account.providerId}:${account.accountKey ?? account.id}`;
  const stored = usageHistorySchema.safeParse(await kv.get(key));
  const history = recordReading(
    stored.success ? stored.data : undefined,
    { usedPercent: account.usedPercent, resetsAt: Date.parse(account.resetsAt) },
    now,
  );
  await kv.set(key, history);
  return { daily: dailyGains(history, now), historySince: history.since };
}
