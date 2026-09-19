# agent-vm-isolate

Teach-tap for agent env isolation. Container versus VM, from Stanislav Kozlovski's interview with David Crawshaw of exe.dev.

Video: [agents need VMs, not containers](https://www.youtube.com/watch?v=1GX18UGoJRw)

The four public functions are `spawnEnv`, `runWorkload`, `assertIsolation`, and `assertLifecycle`.

David Crawshaw's team started with Docker sandboxes for agents. Nested Compose failed inside those containers. The failure here is `nested-cgroup`. Company CI wanted a full machine, including DNS intercept and other net tricks. Those are unavailable in a container. The failure here is `dns-intercept-unavailable`. Even gVisor was not enough for suites that install k3s. Agents need VM-shaped isolation. They also need long-lived environments. Ending a session must not destroy that VM.

This package is that contract without a hypervisor. It is not a cloud. It is not Docker. It is not KVM. Fixtures encode the isolation contract.

`spawnEnv(kind)` returns a handle for `"container"` or `"vm"`. A capability table keyed by `EnvKind` is the only policy. A container that also has nested Compose is not a representable state.

`runWorkload(env, steps)` runs `nested-compose` and `net-dns-intercept`. A container fails nested Compose with `nested-cgroup` before it reads the fixture. It fails DNS intercept with `dns-intercept-unavailable`. A VM succeeds at both. The VM step reads `fixtures/compose-ish.json` and checks `services.postgres`, `services.app`, and that `dns.mode` is `"intercept"`.

`assertIsolation(env)` reports `nestedNetDns` as `"rejected"` for a container and `"allowed"` for a VM.

`assertLifecycle(env)` ends the session, then reports. Session end is private and idempotent. A container is `destroyed`. A later `runWorkload` throws `env destroyed`. A VM stays `alive`. A later workload still runs.

[exe.dev](http://exe.dev/) is an optional 7-day try link with no credit card. This package does not call exe.dev APIs. It does not need a cloud account. The expand-demo stays open. Nothing here claims a product or demo is complete.

```
npm test
```
