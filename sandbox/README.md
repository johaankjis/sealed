# Sandbox MVP integration

`lib/sandbox/createos.ts` implements the unchanged `SandboxRuntime` contract.
It prepares a CSV in a paused CreateOS VM, forks an isolated child per execution,
and destroys/waits for that child before returning a candidate result. Call
`destroy(snapshotId)` in the job's finalizer to remove the dataset snapshot too.
Failed child cleanup blocks subsequent execution; retry `destroy`. `dispose()`
cleans known snapshots, including failed preparations, on worker shutdown.

## Server wiring

The integration owner must add `@nodeops-createos/sandbox@0.8.2` to the root
dependencies. Its published declarations were downloaded to temporary storage
and checked for structural compatibility with `CreateOSClient` using TypeScript.
No shared package files or contracts were modified.

Instantiate the documented SDK `createClient({ apiKey, retry: false })` on the
server and inject it into `new CreateOSRuntime(config)`. Keep credentials solely
in that client. Configuration requires:

- `shape` and a trusted `rootfs` with Python 3, GNU `timeout`, and DuckDB installed.
  Install DuckDB **inside CreateOS**, before private dataset upload and before
  restricting egress. Never install or run it on the application host for queries.
- A nonempty `egress` allowlist and `verifyIsolation(sandbox)` which throws unless
  deployment-specific network checks pass. Do not implement this as a no-op for
  private data. Empty CreateOS allowlists mean unrestricted outbound access.
- `authorizeExecution(snapshotId)`: look up the snapshot-to-job mapping, verify
  authoritative payment state, and atomically claim the paid job. Return false
  for unpaid or already-claimed jobs. This callback runs before forking or code
  upload. Never accept a buyer-provided boolean as payment proof.
- Optional `{ timeoutMs: 30000, maxRetries: 0 }`. Nonzero retry counts are rejected:
  ambiguous timeouts must not replay a paid execution. SDK retries should also
  be disabled at client construction.

Use a trusted registry to resolve the CSV path; never pass a buyer-supplied path.
Bundle `sandbox/runner.py` with the worker at its repository-relative location.
Use a long-lived worker instance: snapshot handles are currently in memory.
Persist provider IDs/job associations and add crash reconciliation before using
multiple workers or serverless invocations.

After `execute`, pass the returned `ExecutionResult` to the shared `OutputPolicy`.
Publish only its approved `ApprovedResult`. This runtime checks JSON shape and
size, not privacy. Never forward errors from SDK calls, VM stdout/stderr, files,
or candidate result rows to buyers. The runtime emits fixed error codes only.
The original contracts do not carry a job/payment binding, so the server wiring
must supply it via the authorization closure. No contract change is required for
this MVP; a durable job-bound execution interface is a future integration topic.

## Generated Python interface

The guest runner provides `con`, an in-memory DuckDB connection, with the CSV
loaded into a table named `dataset`. Analysis must assign `result` to a dict with
`columns`, `rows`, and optional `groupSizes`, matching `contracts/results.ts`.
`smoke_analysis.py` illustrates the interface. Incidental prints and tracebacks
are suppressed. External DuckDB access is disabled after ingestion.

Python execution is not restricted by this wrapper: generated code can bypass
Python-level conveniences, forge group sizes, access guest files, or write to
file descriptors. Provider isolation and an independent output policy remain
essential. The 1 MB parser limit applies after SDK buffering; malicious output
can still consume transport memory. No zero-egress or aggregate-privacy claim
has been demonstrated by this implementation.

## Verification performed (2026-10-17)

- 20 Vitest lifecycle/parser tests passed, including unpaid rejection, cleanup
  failure recovery, concurrent execution rejection, and malformed results.
- TypeScript passed, including an isolated check against SDK 0.8.2 declarations.
- Next.js webpack production build passed using its WASM fallback. Existing local
  dependencies lack `.bin` links and have a broken native SWC binary; use the
  direct commands below until dependency installation is repaired by its owner.
- Authenticated with the existing CreateOS CLI account and used the already
  running `sealed-test` VM; no new resources were provisioned.
- Remote Python: 3.13.14. Remote DuckDB was absent; installed DuckDB 1.5.4 there.
- Uploaded the runner and synthetic fixtures, then ran the command below inside
  CreateOS. It exited 0 and returned east=30, west=70, groupSizes=[2,2]. A separate
  remote DuckDB `SELECT 6 * 7` returned 42.
- The existing VM's firewall returned `rules: []`. No network enforcement test
  was performed. The smoke test used synthetic data, never customer data.

```sh
node node_modules/vitest/vitest.mjs run lib/sandbox/createos.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build --webpack

# Existing authorized CreateOS test VM only; commands execute remotely.
createos sandbox exec sealed-test -- python3 -m pip install duckdb==1.5.4
createos sandbox push sealed-test sandbox/runner.py /tmp/sealed-runner.py
createos sandbox push sealed-test sandbox/smoke.csv /tmp/sealed-dataset.csv
createos sandbox push sealed-test sandbox/smoke_analysis.py /tmp/sealed-analysis.py
createos sandbox exec sealed-test -- timeout --signal=KILL 30s python3 -I /tmp/sealed-runner.py
```

## SDK evidence and remaining blockers

Verified method names and signatures against published SDK 0.8.2 and official
[Sandbox reference](https://createos.sh/docs/Sandbox/SDK/Reference/Sandbox/) and
[Client reference](https://createos.sh/docs/Sandbox/SDK/Reference/Client/).
No missing SDK method was invented. `files.upload` accepts `BodyInit`; the
adapter copies file bytes to an `ArrayBuffer` for compatibility. `runCommand`
accepts request timeout/retry options; the guest `timeout` also bounds execution.

Live pause/fork/destroy lifecycle remains mock-tested only. No extra VM was
provisioned, and the preexisting test VM was not destroyed. A timeout during
provider creation/fork can leave a VM without a returned handle; account-level
reconciliation is required. This adapter cannot recover such IDs itself.

Private-data release is blocked on verified network enforcement, trusted image
provisioning (the DuckDB installation changed the test VM, not `devbox:1`),
payment/job binding, and output-policy integration. The shared result contract
does not attest group-size provenance; do not trust model-reported counts as
privacy evidence. Install the SDK dependency and complete server wiring through
the owning agents. No shared-contract edits were made.
