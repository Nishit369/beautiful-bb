// Live CPU and memory card above the usage card, in its row layout: an icon,
// a bar, and the figure. Load average, the memory breakdown, swap, pressure
// and the busiest process are in each row's tooltip. The server samples every
// two seconds; this only polls while the card is on screen and visible.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { SystemStats } from "./system";
import "./system-card.css";

const GB = 1024 ** 3;
/** The server's sampling tick (system.ts); polling faster would only repeat a reading. */
const POLL_MS = 2000;

type Tone = "calm" | "warm" | "hot";
type Pressure = NonNullable<SystemStats["detail"]>["pressure"];

/** Fractions of capacity at which a row turns warm, then hot. */
const THRESHOLDS = { cpu: [0.7, 0.9], memory: [0.85, 0.95] } as const;
const PRESSURE_TONE: Record<Pressure, Tone> = { normal: "calm", warn: "warm", critical: "hot" };
const TONES: Tone[] = ["calm", "warm", "hot"];

function toneFor(fraction: number, [warm, hot]: readonly [number, number], floor: Tone = "calm"): Tone {
  const byLoad: Tone = fraction >= hot ? "hot" : fraction >= warm ? "warm" : "calm";
  return TONES[Math.max(TONES.indexOf(byLoad), TONES.indexOf(floor))]!;
}

function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry!.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, onScreen] as const;
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function useSystemStats(active: boolean): SystemStats | null {
  const rpc = useRpc<typeof rpcContract>();
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      rpc.call("system_stats", null).then(
        (next) => {
          if (stopped) return;
          setStats(next);
          timer = window.setTimeout(poll, POLL_MS);
        },
        () => {
          if (!stopped) timer = window.setTimeout(poll, POLL_MS * 5);
        },
      );
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [rpc, active]);
  return stats;
}

/** Eases the shown number toward `value` instead of jumping. */
function useTweened(value: number, ms = 700) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min((now - t0) / ms, 1);
      from.current = start + (value - start) * (1 - (1 - t) ** 3);
      setShown(from.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

/** Drawn here because bb's icon set has no chip or memory glyph; 12px grid. */
const ICONS = {
  cpu: (
    <svg viewBox="0 0 12 12" className="bbb-glyph">
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" />
      <rect x="4.75" y="4.75" width="2.5" height="2.5" rx="0.5" className="bbb-glyph-solid" />
      <path d="M4.75 0.75v1.75M7.25 0.75v1.75M4.75 9.5v1.75M7.25 9.5v1.75M0.75 4.75h1.75M0.75 7.25h1.75M9.5 4.75h1.75M9.5 7.25h1.75" />
    </svg>
  ),
  memory: (
    <svg viewBox="0 0 12 12" className="bbb-glyph">
      <rect x="0.75" y="2.5" width="10.5" height="6" rx="1.25" />
      <rect x="2.5" y="4.25" width="2.75" height="2.5" rx="0.5" className="bbb-glyph-solid" />
      <rect x="6.75" y="4.25" width="2.75" height="2.5" rx="0.5" className="bbb-glyph-solid" />
      <path d="M2.75 8.5v2M5 8.5v2M7 8.5v2M9.25 8.5v2" />
    </svg>
  ),
};

function MetricRow(props: {
  icon: keyof typeof ICONS;
  fraction: number;
  tone: Tone;
  title: string[];
  label: string;
  onPointerEnter?: () => void;
  children: ReactNode;
}) {
  const used = Math.min(Math.max(props.fraction, 0), 1) * 100;
  return (
    <li
      className="bbb-row bbb-metric"
      data-tone={props.tone}
      title={props.title.join("\n")}
      aria-label={props.label}
      onPointerEnter={props.onPointerEnter}
    >
      <span className="bbb-icon" aria-hidden="true">
        {ICONS[props.icon]}
      </span>
      <span className="bbb-bar" aria-hidden="true">
        <span style={{ width: `${used}%`, backgroundSize: `${used > 0 ? 10000 / used : 100}% 100%` }} />
      </span>
      <span className="bbb-metric-figure">{props.children}</span>
    </li>
  );
}

const gb = (bytes: number) => (bytes / GB).toFixed(1);

function Metrics({ stats }: { stats: SystemStats }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busiest, setBusiest] = useState<string | null>(null);
  const cpu = useTweened(stats.cpu);
  const memory = useTweened(stats.memory / GB);
  const { detail } = stats;
  const total = Math.round(stats.memoryTotal / GB);
  const memoryFloor = detail ? PRESSURE_TONE[detail.pressure] : "calm";

  return (
    <ul>
      <MetricRow
        icon="cpu"
        fraction={stats.cpu / 100}
        tone={toneFor(stats.cpu / 100, THRESHOLDS.cpu)}
        label={`CPU ${Math.round(stats.cpu)}% used`}
        title={[
          `CPU ${Math.round(stats.cpu)}% across ${stats.cores} cores`,
          `Load average ${stats.load.map((n) => n.toFixed(2)).join(", ")} (1, 5, 15 min)`,
          ...(busiest ? [`Busiest: ${busiest}`] : []),
        ]}
        onPointerEnter={() => {
          rpc.call("top_process", null).then(
            (top) => setBusiest(top ? `${top.name}, ${Math.round(top.cpu)}% of one core` : null),
            () => {},
          );
        }}
      >
        <b>{Math.round(cpu)}%</b>
      </MetricRow>
      <MetricRow
        icon="memory"
        fraction={stats.memory / stats.memoryTotal}
        tone={toneFor(stats.memory / stats.memoryTotal, THRESHOLDS.memory, memoryFloor)}
        label={`Memory ${gb(stats.memory)} of ${total} GB used`}
        title={[
          `Memory used ${gb(stats.memory)} of ${total} GB`,
          ...(detail
            ? [
                `App ${gb(detail.app)}, wired ${gb(detail.wired)}, compressed ${gb(detail.compressed)} GB`,
                `File cache ${gb(detail.cached)} GB, not counted as used`,
                `Swap ${gb(detail.swapUsed)} GB, pressure ${detail.pressure}`,
              ]
            : []),
        ]}
      >
        <b>{memory.toFixed(1)}</b>
        <span> / {total} GB</span>
      </MetricRow>
    </ul>
  );
}

export function SystemCard() {
  const [ref, onScreen] = useOnScreen<HTMLElement>();
  const pageVisible = usePageVisible();
  const stats = useSystemStats(onScreen && pageVisible);
  return (
    <section ref={ref} className="bbb-card bbb-sys" aria-label="CPU and memory" aria-busy={!stats} tabIndex={0}>
      {stats ? <Metrics stats={stats} /> : <ul />}
    </section>
  );
}
