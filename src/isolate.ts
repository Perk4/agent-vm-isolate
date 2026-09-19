import { readFileSync } from "node:fs";

export type EnvKind = "container" | "vm";

export type EnvHandle = {
  readonly id: string;
  readonly kind: EnvKind;
};

export type WorkloadStep =
  | { readonly op: "nested-compose"; readonly fixture: string }
  | { readonly op: "net-dns-intercept" };

export type IsolationReason = "nested-cgroup" | "dns-intercept-unavailable";

export type Result =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failedAt: WorkloadStep["op"];
      readonly reason: IsolationReason;
    };

export type IsolationReport = {
  readonly kind: EnvKind;
  readonly nestedNetDns: "allowed" | "rejected";
};

export type LifecycleReport = {
  readonly kind: EnvKind;
  readonly session: "ended";
  readonly envState: "alive" | "destroyed";
};

const capabilities = {
  container: {
    nestedCompose: false,
    netDnsIntercept: false,
    longLived: false,
  },
  vm: {
    nestedCompose: true,
    netDnsIntercept: true,
    longLived: true,
  },
} as const;

type EnvRecord = {
  readonly id: string;
  readonly kind: EnvKind;
  ended: boolean;
};

const registry = new Map<string, EnvRecord>();
let nextId = 0;

function isEnvKind(kind: string): kind is EnvKind {
  return Object.hasOwn(capabilities, kind);
}

function capFor(kind: string): (typeof capabilities)[EnvKind] {
  if (!isEnvKind(kind)) {
    throw new Error("kind must be container or vm");
  }
  return capabilities[kind];
}

function getRecord(env: EnvHandle): EnvRecord {
  if (typeof env !== "object" || env === null || typeof env.id !== "string") {
    throw new Error("unknown env");
  }
  const record = registry.get(env.id);
  if (record === undefined || record.kind !== env.kind) {
    throw new Error("unknown env");
  }
  return record;
}

function isDestroyed(record: EnvRecord): boolean {
  return record.ended && !capFor(record.kind).longLived;
}

function hasComposeShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("services" in value) || !("dns" in value)) {
    return false;
  }
  const { services, dns } = value;
  if (typeof services !== "object" || services === null) {
    return false;
  }
  if (typeof dns !== "object" || dns === null) {
    return false;
  }
  return (
    "postgres" in services &&
    "app" in services &&
    "mode" in dns &&
    dns.mode === "intercept"
  );
}

function runNestedCompose(cap: (typeof capabilities)[EnvKind], fixture: string): Result {
  if (typeof fixture !== "string" || fixture.length === 0) {
    throw new Error("fixture must be a non-empty string");
  }
  if (!cap.nestedCompose) {
    return {
      ok: false,
      failedAt: "nested-compose",
      reason: "nested-cgroup",
    };
  }
  const raw: unknown = JSON.parse(readFileSync(fixture, "utf8"));
  if (!hasComposeShape(raw)) {
    throw new Error("fixture must encode the isolation contract");
  }
  return { ok: true };
}

function runNetDnsIntercept(cap: (typeof capabilities)[EnvKind]): Result {
  if (!cap.netDnsIntercept) {
    return {
      ok: false,
      failedAt: "net-dns-intercept",
      reason: "dns-intercept-unavailable",
    };
  }
  return { ok: true };
}

function runStep(cap: (typeof capabilities)[EnvKind], step: WorkloadStep): Result {
  switch (step.op) {
    case "nested-compose":
      return runNestedCompose(cap, step.fixture);
    case "net-dns-intercept":
      return runNetDnsIntercept(cap);
    default: {
      const _exhaustive: never = step;
      throw new Error(`unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function spawnEnv(kind: EnvKind): EnvHandle {
  capFor(kind);
  nextId += 1;
  const id = `env-${nextId}`;
  const handle: EnvHandle = Object.freeze({ id, kind });
  registry.set(id, { id, kind, ended: false });
  return handle;
}

export function runWorkload(
  env: EnvHandle,
  steps: readonly WorkloadStep[],
): Result {
  const record = getRecord(env);
  const cap = capFor(record.kind);
  if (isDestroyed(record)) {
    throw new Error("env destroyed");
  }
  for (const step of steps) {
    const result = runStep(cap, step);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

export function assertIsolation(env: EnvHandle): IsolationReport {
  const record = getRecord(env);
  const cap = capFor(record.kind);
  return {
    kind: record.kind,
    nestedNetDns: cap.nestedCompose && cap.netDnsIntercept ? "allowed" : "rejected",
  };
}

export function assertLifecycle(env: EnvHandle): LifecycleReport {
  const record = getRecord(env);
  const cap = capFor(record.kind);
  record.ended = true;
  return {
    kind: record.kind,
    session: "ended",
    envState: cap.longLived ? "alive" : "destroyed",
  };
}
