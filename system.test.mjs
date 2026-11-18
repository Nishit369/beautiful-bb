import assert from "node:assert/strict";
import test from "node:test";
import { cpuPercent, createSystemSampler, parseMemory } from "./system.ts";

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   784591.
Pages wired down:                             275993.
Pages purgeable:                               24165.
File-backed pages:                            770207.
Anonymous pages:                             1075102.
Pages occupied by compressor:                 155812.
`;
const sysctl = "total = 2048.00M  used = 979.00M  free = 1069.00M  (encrypted)\n2\n";
const PAGE = 16384;

test("memory used counts app, wired and compressed pages, not the file cache", () => {
  const { used, detail } = parseMemory(vmStat, sysctl);
  assert.equal(detail.app, (1075102 - 24165) * PAGE);
  assert.equal(detail.wired, 275993 * PAGE);
  assert.equal(detail.compressed, 155812 * PAGE);
  assert.equal(detail.cached, 770207 * PAGE);
  assert.equal(used, detail.app + detail.wired + detail.compressed);
  assert.equal(detail.swapUsed, 979 * 1024 * 1024);
  assert.equal(detail.pressure, "warn");
});

test("CPU percent is the busy share of core time between two readings", () => {
  assert.equal(cpuPercent({ busy: 100, total: 1000 }, { busy: 350, total: 2000 }), 25);
  assert.equal(cpuPercent({ busy: 100, total: 1000 }, { busy: 100, total: 1000 }), 0);
});

test("the first snapshot already carries a live reading, and concurrent callers share it", async () => {
  const sampler = createSystemSampler();
  const [a, b] = await Promise.all([sampler.snapshot(), sampler.snapshot()]);
  assert.equal(a.at, b.at);
  assert.ok(a.cpu >= 0 && a.cpu <= 100);
  assert.ok(a.memory > 0 && a.memory < a.memoryTotal);
  assert.ok(a.cores > 0);
});
