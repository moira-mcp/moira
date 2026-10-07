import type { LocalPolicy } from "./policy.js";

/** Provider identity is locally observed, never a name adopted from a cloud request. */
export interface LocalVmIdentity {
  name: string;
  runtimeId: string;
}
export interface LocalVmObservation {
  id: string;
  name: string;
  status: "running" | "stopped" | "starting" | "stopping" | "created" | "error" | "unknown";
  failure?: string;
}
export type FixedGuestEntrypoint = "installer" | "worker";
export interface LocalVmDispatchAdmission {
  expectedNetworkDigest: string;
  /** Recheck durable owner generation and local grants after backend verification awaits. */
  confirm: () => Promise<void>;
}

/** Each backend proves its own host, filesystem and network isolation. */
export interface LocalVmBoundary {
  verifyConfiguration(): Promise<void>;
  verify(identity: LocalVmIdentity, expectedNetworkDigest?: string): Promise<void>;
  configureNetwork(identity: LocalVmIdentity, brokerPort: number): Promise<string>;
}

/** Portable VM operations; native credentials, sockets and process ownership stay in the backend. */
export interface LocalVmRuntime {
  readonly boundary: LocalVmBoundary;
  list(): Promise<LocalVmObservation[]>;
  inspectExact(identity: LocalVmIdentity): Promise<LocalVmObservation | null>;
  create(name: string): Promise<LocalVmIdentity>;
  start(identity: LocalVmIdentity): Promise<void>;
  stop(identity: LocalVmIdentity): Promise<void>;
  remove(identity: LocalVmIdentity): Promise<void>;
  runFixedGuest(
    identity: LocalVmIdentity,
    entrypoint: FixedGuestEntrypoint,
    input?: Uint8Array,
    timeoutMs?: number,
    signal?: AbortSignal,
    admission?: LocalVmDispatchAdmission,
  ): Promise<Buffer>;
}
export type LocalVmRuntimeFactory = (policy: LocalPolicy) => LocalVmRuntime;
