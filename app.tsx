// Beautiful bb frontend entry. Registers every piece of the plugin: the PRs
// card (prs-card.tsx), the system card (live CPU and memory) and the usage card
// above the sidebar footer (one line per harness: logo, weekly limit bar, 7-day
// token bars, percent used, time to reset), the home wallpaper and greeting,
// the settings page, the effects overlay, and command-menu actions.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { HarnessUsage, rpcContract } from "./server";
import "./usage-card.css";
import "./working-spinner.css";
import { HomeWallpaper } from "./wallpaper";
import { footerCardsClosed, setRowStatusSetter, setUsageCardController, toggleFocusMode } from "./features";
import { mountTypography } from "./typography";
import { SettingsPage } from "./settings-page";
import { EffectsOverlay } from "./overlay";
import { HomeGreeting } from "./greeting";
import { WaveIcon } from "./wave-icon";
import { nextTheme } from "./actions";
import { toggleColorMode } from "./color-mode";
import { PrsCard } from "./prs-card";
import { SystemCard } from "./system-card";
import { usePreferences } from "./use-preferences";

const REFRESH_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function until(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.round((ms % DAY_MS) / HOUR_MS);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

const tokenCount = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** Seven bars of tokens per day, today on the right. */
function TokenBars({ daily, now, providerName }: { daily: number[]; now: number; providerName: string }) {
  const days = daily.length > 0 ? daily : new Array<number>(7).fill(0);
  const peak = Math.max(...days, 1);
  const total = days.reduce((sum, n) => sum + n, 0);
  const scope = `${providerName} on this machine, all accounts`;
  return (
    <span className="bbb-bars" title={daily.length > 0 ? `${scope}: ${tokenCount.format(total)} tokens in the last 7 days` : `${scope}: no local token history available`}>
      {days.map((n, i) => {
        const day = weekday.format(now - (days.length - 1 - i) * DAY_MS);
        return (
          <span
            key={i}
            className="bbb-day"
            data-empty={n === 0 || undefined}
            style={{ height: `${Math.max((n / peak) * 100, 12)}%` }}
            title={daily.length > 0 ? `${scope}, ${day}: ${tokenCount.format(n)} tokens` : `${day}: no local token history available`}
          />
        );
      })}
    </span>
  );
}

function HarnessRow({ h, now }: { h: HarnessUsage; now: number }) {
  const { providers } = useProviders();
  const provider = providers.find((provider) => provider.id === h.providerId) ?? { id: h.providerId };
  const name = h.accountLabel ? `${h.name} — ${h.accountLabel}` : h.name;
  const resetsAt = Date.parse(h.resetsAt);
  const used = Math.min(Math.max(h.usedPercent, 0), 100);
  return (
    <li
      className="bbb-row"
      title={name}
      aria-label={`${name}: ${h.usedPercent}% of weekly limit used, resets ${dayTime.format(resetsAt)}.`}
    >
      <span className="bbb-icon" aria-hidden="true">
        <ProviderIcon providerKind="agent" provider={provider} />
      </span>
      <span className="bbb-bar" aria-hidden="true">
        <span style={{ width: `${used}%`, backgroundSize: `${used > 0 ? 10000 / used : 100}% 100%` }} />
      </span>
      <TokenBars daily={h.daily} now={now} providerName={h.name} />
      <span className="bbb-pct">{h.usedPercent}%</span>
      <span className="bbb-in" title={`Resets ${dayTime.format(resetsAt)}`}>
        {until(resetsAt - now)}
      </span>
    </li>
  );
}

const USAGE_KEY = "beautiful-bb:weekly-usage";

/** The last reading, so a restarted plugin server (cold caches, a slow first call) still shows rows. */
function readCachedUsage(): { harnesses: HarnessUsage[]; observedAt: number } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(USAGE_KEY) ?? "null");
    return Array.isArray(cached?.harnesses) && typeof cached.observedAt === "number" ? cached : null;
  } catch {
    return null;
  }
}

function useWeeklyUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [cached] = useState(readCachedUsage);
  const [harnesses, setHarnesses] = useState<HarnessUsage[] | null>(cached?.harnesses ?? null);
  const [now, setNow] = useState(() => cached?.observedAt ?? Date.now());
  const refetch = useCallback(() => {
    rpc.call("weekly_usage", null).then(
      (result) => {
        setHarnesses(result.harnesses);
        setNow(result.observedAt);
        localStorage.setItem(USAGE_KEY, JSON.stringify(result));
      },
      () => setHarnesses((current) => current ?? []),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    const timer = window.setInterval(refetch, REFRESH_MS);
    window.addEventListener("focus", refetch);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refetch);
    };
  }, [refetch]);
  return { harnesses, now };
}

function WeeklyUsageCard() {
  const { harnesses, now } = useWeeklyUsage();
  if (harnesses === null) return <div className="bbb-card bbb-loading" aria-busy="true" />;
  if (!harnesses.length) {
    return (
      <div className="bbb-card">
        <p className="bbb-empty">Sign in to Claude Code or Codex to see weekly limits here.</p>
      </div>
    );
  }
  return (
    <section className="bbb-card" aria-label="Weekly usage limits" tabIndex={0}>
      <ul>
        {harnesses.map((harness) => <HarnessRow key={harness.id} h={harness} now={now} />)}
      </ul>
    </section>
  );
}

/** The footer shows one disclosure at a time, so both cards share this one. */
function FooterCards() {
  const prefs = usePreferences();
  useEffect(() => footerCardsClosed, []);
  if (!prefs) return null;
  return (
    <>
      {prefs.prsCard && <PrsCard />}
      {prefs.systemCard && <SystemCard />}
      {prefs.usageCard && <WeeklyUsageCard />}
    </>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "bbb-wave", component: WaveIcon });
  app.slots.experimental_appOverlay({ id: "effects", component: EffectsOverlay });
  app.slots.homepageSection({ id: "greeting", title: "Greeting", component: HomeGreeting });
  app.slots.homepageSection({ id: "wallpaper", title: "Wallpaper", component: HomeWallpaper });
  app.slots.navPanel({
    id: "settings",
    title: "Beautiful bb",
    icon: "beautiful-bb/sparkle",
    path: "settings",
    component: SettingsPage,
  });
  // Its footer toggle is hidden by usage-card.css; EffectsOverlay opens it
  // while the PRs, System or Usage card setting is on.
  setUsageCardController(
    app.experimental_sidebarFooter.register({
      kind: "disclosure",
      id: "weekly-usage",
      label: "PRs, system and weekly usage",
      icon: "ChartColumn",
      component: FooterCards,
    }),
  );
  // Only a content script may decorate thread rows; hand its setter to the
  // effects overlay, which marks working threads.
  app.contentScripts.register({ id: "typography", mount: mountTypography });
  app.contentScripts.register({
    id: "thread-row-status",
    mount(context) {
      setRowStatusSetter(context.experimental_setThreadRowStatus ?? null);
      return () => setRowStatusSetter(null);
    },
  });
  app.commands.register({
    id: "toggle-focus-mode",
    title: "Beautiful bb: Toggle focus mode",
    defaultShortcut: { key: "f", mod: true, shift: true },
    run: () => {
      toggleFocusMode();
    },
  });
  app.commands.register({ id: "next-theme", title: "Beautiful bb: Next theme", run: nextTheme });
  app.commands.register({ id: "toggle-color-mode", title: "Beautiful bb: Toggle light and dark", run: toggleColorMode });
});
