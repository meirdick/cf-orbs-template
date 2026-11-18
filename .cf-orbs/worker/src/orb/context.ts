// Everything an op needs, injected so ops are pure and unit-testable. Built by session.ts from the DO.
import type { Clock, ContainerPort, KV } from "../core/container-port";
import type { ProviderConfig, RegistryClient } from "../core/types";

export interface OrbContext {
  orbId: string;
  container: ContainerPort;
  kv: KV; // DO storage; keys: "orb" (OrbRecord), "op:<opId>" (OpRecord), "ops:inflight" (opId[])
  clock: Clock;
  config: ProviderConfig;
  registry: RegistryClient;
  /** Append a progress line to the current op and to the DO log. Must be redacted by the caller. */
  say: (line: string) => void;
  /** Deadline for the current op (epoch ms). Ops must finish or fail before it. */
  deadline: number;
}
