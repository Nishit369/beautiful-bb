// Live CPU and memory for the sidebar system card. The sampler only runs while
// a window keeps asking for it: each snapshot extends a short lease, and the
// timer stops once the lease lapses (card closed, window hidden).
//
// CPU is the busy share of all cores between two ticks, from os.cpus() times.
// Memory is Activity Monitor's "Memory Used": app memory (anonymous pages
// minus purgeable) plus wired plus compressed, read from vm_stat, because
// os.freemem() counts the file cache as used on macOS.
import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

export const TICK_MS = 2000;
const LEASE_MS = 5000;

export const pressureSchema = z.enum(["normal", "warn", "critical"]);
const memoryDetailSchema = z.object({
  app: z.number(),
  wired: z.number(),
  compressed: z.number(),
  /** File-backed pages: the file cache, not counted as used. */
  cached: z.number(),
  swapUsed: z.number(),
  pressure: pressureSchema,
});
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

export const systemStatsSchema = z.object({
  at: z.number(),
  /** Busy percent of all cores over the latest tick, 0-100. */
  cpu: z.number(),
  /** Bytes used. */
  memory: z.number(),
  cores: z.number(),
  /** 1, 5 and 15 minute load averages. */
  load: z.array(z.number()),
  memoryTotal: z.number(),
  /** macOS breakdown of the latest memory figure; null where vm_stat is unavailable. */
  detail: memoryDetailSchema.nullable(),
});
export type SystemStats = z.infer<typeof systemStatsSchema>;

type CpuTimes = { busy: number; total: number };

export function cpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

export function cpuPercent(previous: CpuTimes, next: CpuTimes): number {
  const total = next.total - previous.total;
  return total > 0 ? Math.min(Math.max(((next.busy - previous.busy) / total) * 100, 0), 100) : 0;
}

/** Bytes used plus the parts that make it up, from `vm_stat` and `sysctl` output. */
export function parseMemory(vmStat: string, sysctl: string): { used: number; detail: MemoryDetail } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 4096);
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(vmStat)?.[1] ?? 0) * pageSize;
  const app = Math.max(pages("Anonymous pages") - pages("Pages purgeable"), 0);
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const cached = pages("File-backed pages");
  const [swap = "", level = ""] = sysctl.trim().split("\n");
  const swapUsed = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0) * 1024 * 1024;
  const pressure = level.trim() === "4" ? "critical" : level.trim() === "2" ? "warn" : "normal";
  return { used: app + wired + compressed, detail: { app, wired, compressed, cached, swapUsed, pressure } };
}

async function readMemory(): Promise<{ used: number; detail: MemoryDetail | null }> {
  if (platform() === "darwin") {
    try {
      const [vmStat, sysctl] = await Promise.all([
        run("/usr/bin/vm_stat", { timeout: 2000 }),
        run("/usr/sbin/sysctl", ["-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level"], { timeout: 2000 }),
      ]);
      return parseMemory(vmStat.stdout, sysctl.stdout);
    } catch {
      // Fall through to Node's figure, which counts the file cache as used.
    }
  }
  return { used: totalmem() - freemem(), detail: null };
}

/** The process using the most CPU right now, by `ps`'s recent-average %CPU. */
export async function topProcess(): Promise<{ name: string; cpu: number } | null> {
  try {
    const { stdout } = await run("/bin/ps", ["-Arco", "%cpu=,comm="], { timeout: 2000 });
    const match = /^\s*([\d.]+)\s+(.+)$/m.exec(stdout);
    return match ? { name: match[2]!.trim(), cpu: Number(match[1]) } : null;
  } catch {
    return null;
  }
}

export function createSystemSampler() {
  let latest: Pick<SystemStats, "at" | "cpu" | "memory" | "detail"> | null = null;
  let previous = cpuTimes();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let leaseUntil = 0;
  let warmup: Promise<void> | null = null;

  async function tick() {
    const next = cpuTimes();
    const cpu = cpuPercent(previous, next);
    previous = next;
    const memory = await readMemory();
    latest = { at: Date.now(), cpu, memory: memory.used, detail: memory.detail };
  }

  function schedule() {
    timer = setTimeout(async () => {
      await tick();
      timer = null;
      if (Date.now() < leaseUntil) schedule();
    }, TICK_MS);
    timer.unref();
  }

  return {
    async snapshot(): Promise<SystemStats> {
      leaseUntil = Date.now() + LEASE_MS;
      if (!timer && !warmup) {
        if (latest && latest.at > Date.now() - 2 * TICK_MS) {
          schedule();
        } else {
          // Resuming after a lapse: a CPU delta from the last tick would average over the gap.
          previous = cpuTimes();
          warmup = new Promise((resolve) => setTimeout(resolve, 250))
            .then(tick)
            .finally(() => {
              warmup = null;
              schedule();
            });
        }
      }
      await warmup;
      return { ...latest!, cores: cpus().length, load: loadavg(), memoryTotal: totalmem() };
    },
  };
}
