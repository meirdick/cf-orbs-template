// Registry DO (D2, D3, D15): one instance named "registry", no container.
// RPC methods mirror RegistryClient; logic lives in core/registry-core.ts.
import { DurableObject } from "cloudflare:workers";
import { parseConfig } from "./core/config";
import { realClock, wrapStorage } from "./core/container-port";
import {
  type ForgetResult,
  type GcResult,
  type ProjectSnapshotRow,
  type PruneResult,
  RegistryCore,
  type RegistrySummary,
  type RunSlotResult,
  type SnapshotIndexEntry,
} from "./core/registry-core";
import type {
  ProjectSnapshotMapping,
  ProjectSnapshotStale,
  SnapshotHandle,
  StaleMarkResult,
  WarmResult,
  WarmRun,
  WarmRunView,
} from "./core/types";

/** Bindings this module needs. index.ts defines the full Env. */
export interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  CF_ORBS_CONFIG?: string;
}

export const REGISTRY_NAME = "registry";
export const REGISTRY_GC_INTERVAL_MS = 24 * 3600_000;

export class Registry extends DurableObject<Env> {
  private core?: RegistryCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + REGISTRY_GC_INTERVAL_MS);
      }
    });
  }

  /** Lazy so a bad CF_ORBS_CONFIG fails the RPC with its fix text instead of breaking the DO constructor. */
  private get reg(): RegistryCore {
    if (!this.core) {
      const config = parseConfig(this.env.CF_ORBS_CONFIG);
      this.core = new RegistryCore(wrapStorage(this.ctx.storage), realClock, config);
    }
    return this.core;
  }

  async getProjectSnapshot(snapshotId: string): Promise<ProjectSnapshotMapping | undefined> {
    return this.reg.getProjectSnapshot(snapshotId);
  }
  async putProjectSnapshot(m: ProjectSnapshotMapping): Promise<void> {
    return this.reg.putProjectSnapshot(m);
  }
  async touchProjectSnapshot(snapshotId: string, usedAt: string): Promise<void> {
    return this.reg.touchProjectSnapshot(snapshotId, usedAt);
  }
  async dropProjectSnapshot(snapshotId: string): Promise<void> {
    return this.reg.dropProjectSnapshot(snapshotId);
  }
  async markProjectSnapshotStale(snapshotId: string, reason: string, at: string): Promise<StaleMarkResult> {
    return this.reg.markProjectSnapshotStale(snapshotId, reason, at);
  }
  async projectSnapshotStale(snapshotId: string): Promise<ProjectSnapshotStale | undefined> {
    return this.reg.projectSnapshotStale(snapshotId);
  }
  async listProjectSnapshots(): Promise<ProjectSnapshotRow[]> {
    return this.reg.listProjectSnapshots();
  }
  async forgetProjectSnapshot(snapshotId: string): Promise<boolean> {
    return this.reg.forgetProjectSnapshot(snapshotId);
  }
  async recordSnapshot(handle: SnapshotHandle, orbId: string): Promise<void> {
    return this.reg.recordSnapshot(handle, orbId);
  }
  async pruneCandidates(olderThanMs: number): Promise<PruneResult> {
    return this.reg.pruneCandidates(olderThanMs);
  }
  async forgetSnapshots(ids: string[]): Promise<ForgetResult> {
    return this.reg.forgetSnapshots(ids);
  }
  async orbDeleted(orbId: string, at: string): Promise<void> {
    return this.reg.orbDeleted(orbId, at);
  }
  async acquireRunSlot(orbId: string): Promise<RunSlotResult> {
    return this.reg.acquireRunSlot(orbId);
  }
  async releaseRunSlot(orbId: string): Promise<void> {
    return this.reg.releaseRunSlot(orbId);
  }
  async heartbeat(orbId: string): Promise<void> {
    return this.reg.heartbeat(orbId);
  }
  async listSnapshots(): Promise<Array<SnapshotIndexEntry & { expiresAt: string; expired: boolean }>> {
    return this.reg.listSnapshots();
  }
  async status(): Promise<RegistrySummary> {
    return this.reg.summary();
  }
  async startWarmRun(count: number): Promise<WarmRun> {
    return this.reg.startWarmRun(count);
  }
  async recordWarmResult(runId: string, orbId: string, r: WarmResult): Promise<boolean> {
    return this.reg.recordWarmResult(runId, orbId, r);
  }
  async warmStatus(): Promise<WarmRunView | null> {
    return this.reg.warmStatus();
  }
  /** Run GC now (also used by `cf-orbs doctor` and tests). */
  async gc(): Promise<GcResult> {
    return this.reg.gc(new Date().toISOString());
  }

  /** Daily: drop project maps unused > 72 h, expired snapshots, stale run slots. Always re-arms. */
  async alarm(): Promise<void> {
    try {
      const r = await this.reg.gc(new Date().toISOString());
      if (r.projects + r.snapshots + r.running > 0) {
        console.log(
          `registry gc: dropped ${r.projects} project maps, ${r.snapshots} snapshots, ${r.running} run slots`,
        );
      }
    } catch (e) {
      // Do not rethrow: a retried alarm would race the re-arm below. Next run is in a day.
      console.error(`registry gc failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.ctx.storage.setAlarm(Date.now() + REGISTRY_GC_INTERVAL_MS);
  }
}
