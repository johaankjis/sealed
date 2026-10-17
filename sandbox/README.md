# Sandbox MVP integration

Reusable image preparation is documented in [template/README.md](template/README.md).
The Python/DuckDB 1.5.4 definition is committed but **not built**: the current
CreateOS Free plan shows `Upgrade plan` for templates despite available credits.
No template name or restrictive-egress verification is claimed yet.

`lib/sandbox/createos.ts` implements the unchanged `SandboxRuntime` contract.
It uploads a CSV or Parquet file to a paused CreateOS VM, forks a child for each
execution attempt, waits for `running`, and destroys/waits for that child before
returning a candidate result. Call `destroy(snapshotId)` in the job finalizer to
remove the dataset snapshot too.

## Server wiring

The integration owner must add `@nodeops-createos/sandbox@0.8.2` to the root
package dependencies. This version was tested live, using its published package
in temporary storage. No shared package files or contracts were modified.

Create the SDK client on the server with `createClient({ apiKey, retry: false })`
and inject it into `new CreateOSRuntime(config)`. Credentials stay in that client,
never in the VM. Configuration requires:

- `shape` and a trusted `rootfs` with Python 3, GNU `timeout`, and DuckDB installed.
  Install DuckDB **inside CreateOS**, before private data upload and before
  restricting egress. The live test bootstraps its own temporary VM remotely;
  installing DuckDB in a VM does not change the `devbox:1` base image.
- A nonempty `egress` allowlist and `verifyIsolation(sandbox)` which throws unless
  deployment-specific network checks pass. Empty CreateOS allowlists permit all
  egress. The live test only checks configuration readback with synthetic data;
  it does not establish a zero-egress guarantee.
- `resolveTableName(datasetId)` from the trusted catalog, matching the agent's
  `DatasetDescriptor.tableName`. It defaults to `dataset`. For the agent's retail
  fixture it must return `orders`. The runner quotes this identifier and reads
  CSV/Parquet via fixed paths; buyer input must never select local file paths.
- `authorizeExecution(snapshotId)` must verify that the attempt belongs to the
  already claimed, paid job. The orchestrator itself claims `paid -> running`:
  **do not claim that transition again here**, or reject its authorized retries.
  Use a job-scoped runtime/closure or trusted snapshot-to-job association, and
  consult authoritative payment state. Never trust a buyer-provided paid flag.
- Optional runtime `{ timeoutMs: 30000, maxRetries: 0 }`. Runtime/provider retries
  are disabled to prevent replay on ambiguous failures. The agent's separate
  `maxRetries: 2` option controls new analysis attempts and must not be passed
  directly as runtime options. Each accepted attempt gets a fresh fork.

Use a long-lived worker instance; snapshot handles and pending cleanup are in
memory. Bundle `sandbox/runner.py` at its repository-relative location. Durable
job/snapshot associations and crash reconciliation are required for serverless
or multiple workers. A provider timeout during create/fork may allocate a VM
without returning its ID; account-level reconciliation must cover this case.

After `execute`, pass the candidate `ExecutionResult` to `OutputPolicy.validate`.
Publish only the approved result. Shape/size parsing is not privacy approval.
Never forward VM stdout/stderr, files, SDK errors, or candidate rows to buyers.
The runtime emits fixed error codes and withholds results if cleanup fails.

## Agent Python compatibility

Read against `lib/agent/README.md`, `codegen.ts`, and the agent's exact `safeCode`
fixture. The runner supplies the preloaded DuckDB connection `con` and accepts
one printed JSON line containing `columns`, `rows`, and optional `groupSizes`.
It retains compatibility with the original `result = {...}` interface when
nothing is printed. Mixed/debug output, invalid JSON, exceptions, and output
above 1 MB fail without relaying tracebacks. External DuckDB access is disabled
after ingestion. CSV and Parquet are supported.

Python execution is not restricted by this wrapper. Generated code can bypass
Python conveniences, forge group sizes, access guest files, and write directly
to file descriptors. Provider isolation and independent output checks remain
necessary. The host parser's 1 MB limit applies after SDK buffering; direct
malicious output can still consume transport memory. The result contract does
not attest group-size provenance; model-reported counts are not privacy proof.

## Timeouts and cleanup

The guest command is `timeout --foreground --signal=KILL <seconds>s python3 -I
/tmp/sealed-runner.py`. Foreground mode keeps the timeout supervisor alive to
report exit 137 when Python is killed. The VM is then destroyed, including any
remaining descendant processes. A transport timeout also enters child cleanup.
Exit 124/137 maps to `SANDBOX_TIMEOUT`; other errors use fixed failure codes.
The request timeout allows five additional seconds over the guest budget.

An orchestrator deadline only abandons its promise. `destroy()` now waits for
an active execution's bounded command and child cleanup, then removes the
snapshot, instead of failing with `SNAPSHOT_BUSY`. New attempts are rejected
while execution/destruction is in progress. Configure the outer deadline to
allow VM readiness and cleanup as well as the guest computation budget.

Cleanup failures remain retryable. Parent deletion is attempted even if a child
is stuck; `dispose()` visits all known snapshots and pending children without
stopping at the first failure. Provider destruction is asynchronous, so a
`destroying` response is not treated as confirmed deletion.

## Live verification, 2026-10-17

SDK 0.8.2, remote Python 3.13.14, remote DuckDB 1.5.4, synthetic data only.
See `live-smoke-report.json` for the successful run and provider IDs.

| Check | Result |
| --- | --- |
| Agent's exact printed-JSON Python fixture | Passed through the runner and runtime; EU average 12.5, US average 20, 10 records per group |
| Legacy assignment output | Passed |
| CSV and Parquet / catalog table `orders` | Passed |
| Invalid JSON, extra output, exception, oversized output | All rejected with empty stdout/stderr |
| Snapshot pause and wait | Reached `paused` |
| Fork / explicit wait for readiness | Three children reached `running` |
| Successful runtime execution | Exit 0; child confirmed `destroyed` before result returned |
| Infinite-loop timeout | Guest exited 137 after 2038 ms directly and 2046 ms through runtime (2000 ms budget) |
| Concurrent destroy during execution | Third child timed out after 2051 ms, then child and snapshot reached `destroyed` |
| Final cleanup | All four resources in the successful run confirmed `destroyed` |
| Local verification | 25 sandbox + 26 agent tests passed; TypeScript and production webpack build passed |

An earlier test fork (`sb-01m560a6e4ye86tqj2qdkhnmg4`) was used before adding the
explicit readiness wait. Its cleanup exceeded the wait budget in `destroying`.
A subsequent CLI deletion retry confirmed `destroyed` at 22:45:01 UTC. Its parent
and the intermediate runner-test VM were also deleted. Final account listing
contained only the preexisting `sealed-test` VM; no test-created resources remain.

This verifies the agent's Python protocol and saved fixture, not a new live
Claude API generation. No Anthropic credential was available to the test.
No generated analysis or DuckDB query was executed on the application host.

## Reproduce

The live test creates billable resources: run only in an explicitly authorized
account. It installs DuckDB in a dedicated VM, uses synthetic data, and cleans
up all IDs it obtains. Its synthetic authorization callback is not production
payment wiring. Refresh an existing CLI login with `createos whoami` first if
using `--cli-auth`; the SDK itself does not refresh the CLI OAuth token.

```sh
node node_modules/vitest/vitest.mjs run lib/sandbox/createos.test.ts lib/agent/__tests__
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build --webpack

# Node 24; root SDK dependency installed, with server API key in environment:
node --experimental-transform-types sandbox/live-smoke.ts --run

# Alternatively, authorized existing CLI login and SDK downloaded outside repo:
SEALED_CREATEOS_SDK_MODULE=/tmp/sealed-createos-sdk/package/dist/index.js \
SEALED_SMOKE_REPORT=/tmp/sealed-live-report.json \
node --experimental-transform-types sandbox/live-smoke.ts --run --cli-auth
```

Existing dependencies have a damaged native SWC binary; the production build
passes with Next.js's WASM fallback. The direct commands avoid missing `.bin`
links. No shared dependency repair was attempted.

## SDK findings and remaining integration work

All methods are documented in the official [Sandbox reference](https://createos.sh/docs/Sandbox/SDK/Reference/Sandbox/)
and [Client reference](https://createos.sh/docs/Sandbox/SDK/Reference/Client/).
Snapshot/fork **works**. The critical incompatibility was treating the returned
fork handle as immediately ready: it is initially `forking` and requires
`waitUntilRunning()` before uploads or commands. OAuth uses `X-Access-Token`
via SDK `authHeaders`, not a Bearer header. Test VM names must be <=22 characters.
No SDK functionality remains blocked in the successful synthetic lifecycle.

Production wiring still needs the SDK dependency, trusted DuckDB image,
job/payment binding, output-policy integration, and verified network controls.
No orchestration, security, or shared-contract files were modified.
