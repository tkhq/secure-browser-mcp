# Experimental isolated Lightpanda

This replaces PR #28's in-broker subprocess with an externally started,
credential-free worker. It builds on current main's BrowserHost, caller-owned
browser handles, scoped pending approvals, isolated CDP observations, per-write
binding checks and redaction. It does not implement the separate proposals for
iframe fills, fill intent or additional read-back redaction.

## Boundary

Run the broker and worker in **different containers and network namespaces**.
The worker accepts one connection on a Unix socket in a dedicated IPC directory
(mode 0700; socket 0600; both owned by the service UID). Mount only that directory
into the broker, read-only. Never mount broker source overlays, home, state,
credentials, Kubernetes tokens, host runtime sockets or host devices into the
worker. The worker image contains only application code and public dependencies.
Filesystem permissions and exclusive volume assignment authenticate this local
transport; there is no TCP control endpoint or reusable bearer credential.
Operators with access to the socket directory remain trusted.

The worker starts Lightpanda only after accepting its sole client. It replaces
the browser environment with an allowlist, discards browser stdout/stderr, and
keeps raw CDP on worker-local loopback. The broker never starts containers or
receives orchestration privileges. A second client, failed startup, disconnect,
worker crash or expiry consumes the worker. No reconnect, session reassignment,
worker pool, or automatic replacement is attempted. Provision a new worker and
broker instance for the next session. The runtime deliberately allocates only
one Lightpanda host per broker instance; it is not a multi-tenant worker pool.

The worker's lifetime is at most five minutes, including idle startup time.
Disconnect sends SIGTERM to the browser and escalates to SIGKILL after one second.
Container exit removes remaining processes; use an init process, no restart
policy, resource limits and an external container lifetime bound. Broker close
requests teardown by closing the channel; it is not a synchronous attestation
that a compromised remote container was destroyed. The independent lifetime cap
bounds orphan cleanup. Retire the container and IPC directory after every run.

Default worker networking is `none`: no LAN, broker, cluster API, metadata, DNS
or Internet access. The Unix socket still works. A test fixture can listen on
loopback **inside the worker container**. This is deliberately an offline
experiment. Real browsing requires an independently reviewed egress design;
never add a default bridge or broad Internet rule as a shortcut. A broker can
have its own network access without granting it to the browser.

A same-Pod sidecar shares networking and cannot enforce this boundary with
ordinary Kubernetes NetworkPolicy. Separate Pods require an additional
mutually authenticated transport and provisioning design; this Unix-socket
example does not pretend to provide cross-Pod IPC. Do not use hostPath to bridge
Pods. Chroot alone only changes filesystem path resolution: it does not isolate
environment, credentials, file descriptors, processes or networking. Containers
add namespace, mount, capability and seccomp boundaries but share the kernel;
gVisor, Kata or a VM can strengthen the kernel boundary as a later deployment
choice, subject to CDP compatibility and operational review.

## Existing security retained, and new checks

- `BrowserHandles` still binds handles to endpoint, principal and OAuth client.
- `validateTargets`, `observeTargets`, `assertSameDestination` and per-write
  `recheckTarget` remain authoritative. Nothing falls back to page-controlled
  selector evidence when CDP fails.
- `LightpandaHost.openPage` creates a fresh browser context and runs an observation
  gate: nonempty frame/loader identity, isolated-world resistance to page globals
  and DOM prototype overrides, and a new loader identity after navigation.
  Failure closes the worker. A gate is not a security proof for arbitrary binary
  versions: pin and test each version.
- Only the explicitly authorized plaintext field value crosses CDP during a
  fill. Turnkey keys, export bundles and broker state do not cross the boundary.
  The intended destination page necessarily sees a value filled into it.
- The SDK's `mcpReq.signal` now reaches tools. Cancellation consumes an attached
  Lightpanda worker and is checked before export and immediately before each
  plaintext CDP write. Values are released on failure. Cancellation cannot undo
  a write already sent, revoke an export proposal already submitted, or guarantee
  cancellation delivery over a disconnected transport; the worker deadline
  remains the backstop. Human MCP elicitation is still not implemented; existing
  Turnkey quorum policy supplies actual approval when configured.

## Build and offline verification

`examples/lightpanda/Dockerfile` pins Bun's Linux amd64 image and verifies the
Lightpanda 1.0.0 binary hash. Obtain `lightpanda-x86_64-linux` from the official
`lightpanda-io/browser` 1.0.0 GitHub release, place it as `lightpanda` in an
allowlisted build context, and verify SHA-256:

`aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3`

Context: `package.json`, `bun.lock`, `src/`, the three named Lightpanda integration/lifecycle
fixture files, `scripts/probe-lightpanda-worker.ts`, the example Dockerfile and
that binary. No `.env`, home directories, credentials, Git history or private
configuration. Build locally; do not publish a lab image by default.

Run `examples/lightpanda/test-offline.sh IMAGE` on an isolated Linux Docker host
whose invoking UID is 1000. The script runs two temporary containers with no
network, a private socket directory, read-only roots, no capabilities, no new
privileges and bounded resources. It tests live observations, mock approval,
synthetic injection, redaction, wrong destinations and exclusive attachment.
Run `examples/lightpanda/test-lifecycle.sh IMAGE` to verify active expiry and
external worker-container crash invalidate the session and refuse reconnect.
It is not an interactive MCP service and never uses Turnkey credentials.

For broker wiring, set `SBM_BROWSER=lightpanda` and `SBM_LIGHTPANDA_SOCKET` to the
operator-assigned private socket. No raw browser URL, extra browser arguments,
remote endpoint or automatic Browserbase fallback is accepted. Run `src/index.ts`
for stdio MCP after separately provisioning the worker. This single-worker
configuration is intended for private experiments, not a hosted shared service.

## Validation scope

The default unit/integration suite uses Chrome for existing end-to-end flows;
`test/lightpanda-integration.test.ts` is explicitly skipped unless a dedicated
worker socket is supplied. Run the offline script to cover the pinned Lightpanda
binary. Mock approval is a timer, not Turnkey quorum, and synthetic values are
not personal credentials. Do not interpret those tests as approval to configure
real secrets or as a complete browser sandbox audit.

Before any real-secret deployment: review the exact image, isolated runtime,
worker allocation/termination guarantees, destination egress policy and transport
ownership; separately approve the personal Turnkey identity/project and narrowly
scoped credential configuration. No Kubernetes deployment, RBAC, TLS, ingress,
credential provisioning or network changes are performed by this implementation.
