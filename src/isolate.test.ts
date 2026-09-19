import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EnvKind } from "./isolate.ts";
import {
  assertIsolation,
  assertLifecycle,
  runWorkload,
  spawnEnv,
} from "./isolate.ts";
import * as isolate from "./isolate.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "fixtures", "compose-ish.json");

test("public function names are the four primitives", () => {
  const names = Object.entries(isolate)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(names, [
    "assertIsolation",
    "assertLifecycle",
    "runWorkload",
    "spawnEnv",
  ]);
});

test("spawnEnv returns distinct handles and rejects a bad kind", () => {
  const container = spawnEnv("container");
  const vm = spawnEnv("vm");
  assert.deepEqual(container, { id: container.id, kind: "container" });
  assert.deepEqual(vm, { id: vm.id, kind: "vm" });
  assert.notEqual(container.id, vm.id);
  assert.throws(
    () => spawnEnv("process" as EnvKind),
    /kind must be container or vm/,
  );
});

test("container nested compose fails at nested-cgroup", () => {
  const container = spawnEnv("container");
  assert.deepEqual(
    runWorkload(container, [{ op: "nested-compose", fixture }]),
    { ok: false, failedAt: "nested-compose", reason: "nested-cgroup" },
  );
});

test("container nested compose fails before reading the fixture", () => {
  const container = spawnEnv("container");
  assert.deepEqual(
    runWorkload(container, [
      { op: "nested-compose", fixture: "/no/such/compose-ish.json" },
    ]),
    { ok: false, failedAt: "nested-compose", reason: "nested-cgroup" },
  );
});

test("vm nested compose throws when the fixture is missing", () => {
  const vm = spawnEnv("vm");
  assert.throws(
    () =>
      runWorkload(vm, [
        { op: "nested-compose", fixture: "/no/such/compose-ish.json" },
      ]),
    /ENOENT/,
  );
});

test("vm nested compose succeeds", () => {
  const vm = spawnEnv("vm");
  assert.deepEqual(
    runWorkload(vm, [{ op: "nested-compose", fixture }]),
    { ok: true },
  );
});

test("container net dns intercept is unavailable", () => {
  const container = spawnEnv("container");
  assert.deepEqual(
    runWorkload(container, [{ op: "net-dns-intercept" }]),
    {
      ok: false,
      failedAt: "net-dns-intercept",
      reason: "dns-intercept-unavailable",
    },
  );
});

test("vm runs both workload steps", () => {
  const vm = spawnEnv("vm");
  assert.deepEqual(
    runWorkload(vm, [
      { op: "nested-compose", fixture },
      { op: "net-dns-intercept" },
    ]),
    { ok: true },
  );
});

test("assertIsolation rejects nested net dns on a container", () => {
  const container = spawnEnv("container");
  assert.deepEqual(assertIsolation(container), {
    kind: "container",
    nestedNetDns: "rejected",
  });
});

test("assertIsolation allows nested net dns on a vm", () => {
  const vm = spawnEnv("vm");
  assert.deepEqual(assertIsolation(vm), {
    kind: "vm",
    nestedNetDns: "allowed",
  });
});

test("container session end destroys the env", () => {
  const container = spawnEnv("container");
  assert.deepEqual(assertLifecycle(container), {
    kind: "container",
    session: "ended",
    envState: "destroyed",
  });
  assert.throws(
    () => runWorkload(container, [{ op: "net-dns-intercept" }]),
    /env destroyed/,
  );
});

test("vm session end leaves the env alive", () => {
  const vm = spawnEnv("vm");
  assert.deepEqual(assertLifecycle(vm), {
    kind: "vm",
    session: "ended",
    envState: "alive",
  });
  assert.deepEqual(
    runWorkload(vm, [{ op: "nested-compose", fixture }]),
    { ok: true },
  );
});

test("assertLifecycle is idempotent", () => {
  const vm = spawnEnv("vm");
  const container = spawnEnv("container");
  assertLifecycle(vm);
  assert.deepEqual(assertLifecycle(vm), {
    kind: "vm",
    session: "ended",
    envState: "alive",
  });
  assertLifecycle(container);
  assert.deepEqual(assertLifecycle(container), {
    kind: "container",
    session: "ended",
    envState: "destroyed",
  });
});
