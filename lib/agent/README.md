# lib/agent — backend orchestration (owner: Claude Code)

Job lifecycle, Claude code generation, the paid-query execution loop, and the
server composition root that wires lib/payments, lib/sandbox and lib/security
into the Next.js API routes.

## Modules
- `orchestrator.ts`: `createJob`, `startCheckout`, `confirmPayment`, `failPayment`, `executeJob`.
- `server.ts`: the composition root. `getAgentRuntime()` holds the **single** `JobStore` and builds the Stripe provider, CreateOS runtime, Claude generator and `AggregateOnlyOutputPolicy` lazily. It also exports the webhook hooks `handleVerifiedPayment` and `handleFailedPayment`, plus `reconcilePayment` and `toBuyerJob`.
- `jobStore.ts`: `JobStore` with atomic `transition(id, from, to)`, and `InMemoryJobStore`.
- `executionAuth.ts`: `SnapshotAuthorizer` provides `authorizeExecution` for `CreateOSRuntime`, which maps a snapshot to its job. `server.ts` also passes `resolveTableName` from the catalog, so the runner's table and the generated SQL agree.
- `groupSizes.ts`: a fail-closed group-size evidence check that runs before the output policy.
- `codeCheck.ts`: pre-flight check on generated Python. It includes GLM's `validateGeneratedCode` and requires `result = {..., groupSizes}`.
- `codegen.ts`: `ClaudeCodeGenerator` (forced `submit_analysis` tool). Its runtime contract matches `sandbox/runner.py`: `con`, table `dataset`, assign `result`.
- `catalog.ts` and `demo/coffee.ts` / `fixtures/downtown-coffee-sales.csv`: the synthetic coffee-chain dataset (20,010 rows, seed 42). Regenerate it with `node lib/agent/demo/coffee.ts`.
- `http.ts`: maps errors to buyer-safe HTTP responses.
- `egress.ts`: the in-sandbox egress probe (`verifyEgressBlocked`), shared by `server.ts` and the live test.
- `live/`: a manual, billable live smoke test (`coffee-live.ts --run`). Nothing in the app may import it. See `live/README.md`.

## API routes (app/api, added in Sprint 2)
| Route | Behaviour |
| --- | --- |
| `POST /api/jobs` `{datasetId, question}` | Runs `validateQuestion` and checks the catalog. Returns `201` with a `QueryJob` (`created`). Never executes. |
| `GET /api/jobs/:id` | Returns the buyer view (no `stripeSessionId`). If the job is `payment_pending`, asks Stripe about the **server-stored** session (throttled to once per 5s per job) and starts execution when it is paid. |
| `POST /api/checkout` `{jobId}` | Served by lib/payments (`handleCheckoutPost`), which calls `startCheckout`. Prices the job from the catalog. `created -> payment_pending`. A retry while `payment_pending` returns the *same* session, but only if Stripe confirms it belongs to the job and is still unpaid. Otherwise, and for paid, running, failed or completed jobs, the response is `409`. |

No route accepts a session ID, a "paid" flag, or a price from the buyer.

## Payment enforcement (layers)
1. A job only becomes `paid` through `confirmPayment`, which calls `PaymentProvider.verifyPayment` against Stripe and checks that the job ID and session match.
2. `executeJob` runs GLM's `canExecuteJob`, re-verifies with Stripe, then atomically claims `paid -> running`, so only one caller wins.
3. Before every fork, `CreateOSRuntime` calls `SnapshotAuthorizer.authorize`, which allows only a snapshot bound to a job that is currently `running` with a Stripe session.

## Fail-closed group sizes
`AggregateOnlyOutputPolicy` accepts results with no `groupSizes`. `executeJob`
rejects them before the policy runs. It also rejects results where a group is
below `minGroupSize` (10, from GLM's defaults) where the group sizes add up
to more than the dataset row count from the catalog, or where the catalog has no
`rowCount` for the dataset. If the policy throws, the
job fails closed.

## Webhook wiring (for the Stripe route owner; not modified here)
No webhook route exists on main. When it is added (per `lib/payments/README.md`), wire it like this:
```ts
import { handleFailedPayment, handleVerifiedPayment } from "@/lib/agent/server";
await paymentExecutionGate.handleWebhook(rawBody, signature, {
  onPaidJobClaimed: handleVerifiedPayment,
  onPaymentFailed: handleFailedPayment,
});
```
The JobStore stays authoritative. The gate's in-memory claim set is only for deduplication.
Until the route exists, buyer polling on `GET /api/jobs/:id` advances paid jobs.

## Environment variables (server only; never in the sandbox)
| Variable | Required | Used by |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Claude code generation |
| `SEALED_CLAUDE_MODEL` | no (default `claude-sonnet-5-5`) | Claude code generation |
| `STRIPE_SECRET_KEY` | yes | Checkout and payment verification |
| `STRIPE_WEBHOOK_SECRET` | for the webhook route | lib/payments |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | no (default `http://localhost:3000`) | Checkout return URLs |
| `SEALED_SANDBOX_MODE` | no (default `snapshot-fork`) | `snapshot-fork` or `single-synthetic`; any other value returns `503` (fail closed) |
| `CREATEOS_SANDBOX_API_KEY` | yes (both modes) | CreateOS SDK client (`createClient({ apiKey, retry: false })`); key for the credited account |
| `SEALED_CREATEOS_SHAPE` | snapshot-fork | e.g. `s-1vcpu-1gb` |
| `SEALED_CREATEOS_ROOTFS` | snapshot-fork | Trusted image with python3, DuckDB and GNU `timeout` |
| `SEALED_CREATEOS_EGRESS` | snapshot-fork | Comma-separated, **non-empty** allowlist (empty means unrestricted) |
| `SEALED_EGRESS_PROBE_HOST` | no (default `1.1.1.1`) | snapshot-fork; must be outside the allowlist; see below |
| `SEALED_SHARED_SANDBOX_ID` | single-synthetic | Must equal `sb-01m563ts9ekxrv0q85yptqsrh7` (`sealed-runtime`), or the mode refuses to start |
| `SEALED_DATA_DIR` | no (default `lib/agent/fixtures`) | Location of dataset CSVs |

`getAgentRuntime()` checks that execution is configured before it builds
anything. It needs `ANTHROPIC_API_KEY`, `CREATEOS_SANDBOX_API_KEY`, and either
the snapshot-fork variables or the exact `SEALED_SHARED_SANDBOX_ID`. If anything
is missing, `POST /api/jobs` returns `503` and no job or checkout is created, so
buyers can't pay for a query that can't run. The log names the variable but
never its value. `STRIPE_SECRET_KEY` is still checked lazily, at checkout.

## Diagnosing failed jobs
Buyers only see an opaque `errorCode`. Operators get redacted server log lines.
These contain only codes, error classes, HTTP statuses, exit codes and file
basenames. They never include messages, stdout/stderr, generated code, data or
keys.
- `[sealed] {"type":"stage_failed","stage":...,"code":...}`. The `stage` is one
  of `dataset`, `sandbox_prepare`, `generation`, `sandbox_execute`, `policy` or
  `sandbox_destroy`. The `code` comes from `diagnostics.ts`. Examples:
  - `CONFIG:CREATEOS_SANDBOX_API_KEY`;
  - a lib/sandbox code such as `SHARED_ATTACHMENT_REJECTED`,
    `SHARED_EGRESS_UNVERIFIED`, `SHARED_LEASE_UNAVAILABLE`,
    `SYNTHETIC_DATA_REQUIRED`, `SHARED_SANDBOX_BUSY`, `SANDBOX_TIMEOUT` or
    `SHARED_RECONCILIATION_REQUIRED`;
  - an SDK class and status, such as `AuthenticationError:401`.
- `[sealed] {"type":"job_finished",...,"errorCode":...}`.
- In single-synthetic mode, `[sealed] createos {...}` reports which provider
  call failed. That covers `attach` (with sandbox status and ingress),
  `egress_readback`, `upload` (with file basename) and `command` (with
  `kind` set to `egress_probe`, `lease`, `supervisor`, `cleanup` or `other`,
  plus the exit code). The adapter collapses SDK errors into one fixed code, so
  this is how to tell, for example, an auth failure from an upload timeout.

`verifyIsolation` runs a probe inside each sandbox, before any data or code is
uploaded, that tries a TCP connection to the probe host on port 443. Any result
other than `BLOCKED` aborts the run. This is evidence for one destination only,
not a zero-egress guarantee.

## Sandbox modes
**`snapshot-fork` (default).** Each job gets a fresh VM, and each attempt gets
its own fork. This is the mode intended for isolation. It still needs live
validation with a prepared template (see Integration blockers).

**`single-synthetic` (explicit opt-in, demo only).** This uses Codex's
`SingleSandboxRuntime` (`lib/sandbox/single.ts`, `sandbox/SINGLE_SANDBOX.md`) on
the existing `sealed-runtime` VM, attached with `getSandbox` only. It never
creates, forks, pauses or destroys a VM.

> **This is a cooperative shared VM, not isolation.** Jobs share a guest user
> and can deliberately escape the supervisor or leave changes behind. Use it
> only with the reviewed synthetic fixtures. Never use it for customer data or
> untrusted tenants.

How single-synthetic mode is wired in `server.ts`:
- **Opt-in checked at startup:** `sandboxModeFromEnv` selects the mode.
  `createSingleSandboxRuntime` calls Codex's `singleSandboxFromEnv`, which
  rejects a missing opt-in or the wrong shared sandbox ID. It logs a warning.
- **Synthetic data only:** the dataset allowlist is
  `SYNTHETIC_DATASET_REGISTRY` in `catalog.ts`, which holds the reviewed SHA256
  digest and table name. Any other file bytes are refused before the VM is
  contacted. `catalog.test.ts` checks the digest against the file.
- **Payment gating unchanged:** `SnapshotAuthorizer` binds the per-job handle,
  and the adapter calls it before uploading generated code. Jobs still only run
  after payment is verified (Stripe webhook or buyer poll), exactly as in the
  default mode.
- **Queued, one at a time:** `SequentialSandboxRuntime` serializes whole
  prepare → execute → destroy lifecycles, with a fresh adapter instance per job
  and a 10-minute queue wait limit. It sits inside `AgentDeps.sandbox`, so both
  the poll path and the webhook route's direct `executeJob` call are
  serialized. Without it, concurrent jobs would fail with `SHARED_SANDBOX_BUSY`.
- **No generation retries:** `maxRetries` is 0, because each lifecycle allows
  exactly one `execute`.
- **Timeouts and cleanup:** the remote supervisor enforces a 30s limit (exit
  124 maps to `execution_failed`). The adapter removes the job's temporary
  directory before returning a result. If the transport is ambiguous, the
  adapter quarantines the lease. Later jobs then fail closed with
  `sandbox_unavailable` instead of waiting, until an operator reconciles it as
  described in `sandbox/SINGLE_SANDBOX.md`. Never recover by destroying the VM.
- **Same validation as the default mode:** the group-size check and
  `AggregateOnlyOutputPolicy` still decide what is published.

Example (server environment only; never commit):
```dotenv
SEALED_SANDBOX_MODE=single-synthetic
SEALED_SHARED_SANDBOX_ID=sb-01m563ts9ekxrv0q85yptqsrh7
CREATEOS_SANDBOX_API_KEY=<credited-account sandbox key>
ANTHROPIC_API_KEY=<key>
STRIPE_SECRET_KEY=<sk_test_... key>
```

## Running
Use a long-lived process: `npm run build && npm start`. Serverless will not
work, because jobs run in the background and CreateOS snapshot handles are in
memory.

## Tests
`npx vitest run lib/agent`. `integration.test.ts` drives the real routes,
`ClaudeCodeGenerator`, `CreateOSRuntime`, and `AggregateOnlyOutputPolicy`.
Simulated: the Anthropic HTTP response, Stripe, and the CreateOS VM. The fake VM
checks that the runner, dataset and generated code were uploaded, then computes
the expected SQL result in TypeScript. Generated Python is never run on the host.
`integration-single.test.ts` covers single-synthetic mode the same way, with a
fake shared VM that follows Codex's lease, probe, supervisor and cleanup
protocol. It covers:
- a completed coffee job;
- no VM contact before payment;
- concurrent jobs run one at a time;
- a remote timeout;
- a policy rejection;
- a synthetic-digest mismatch;
- quarantine.

Shared simulation helpers live in `coffeeSim.ts`.

## Integration blockers
1. **No live end-to-end run yet.** That needs Stripe test keys, an Anthropic key, and a CreateOS image with DuckDB preinstalled. Codex installed DuckDB on the `sealed-test` VM, not in a reusable rootfs.
2. **Group-size provenance.** `groupSizes` are produced by generated code, so they can be forged within the row-count bound. True provenance needs the runner, or a server-authored query, to compute counts. That is a sandbox and contract change for Codex and GLM.
3. **Egress.** The probe is only partial evidence. Do not claim zero egress.
4. **Retries vs. Codex's "no replay" rule.** The sandbox has `maxRetries: 0`. The agent loop may run *new* generated code after a failure, up to 3 attempts per paid job. If the owners want strictly one execution per payment, set `options.maxRetries: 0` in `server.ts`.
5. **Persistence.** The `InMemoryJobStore` is lost on restart. Postgres should implement `transition` as `UPDATE ... WHERE id=$1 AND status=$2 RETURNING *`.
6. **Frontend catalog.** Only `downtown-coffee-sales` exists on the backend. The other listings in `components/datasets.ts` return `404` from `POST /api/jobs`.
7. **Webhook route** is missing (see above).
8. **Suggested contract additions** (not made): a shared `DatasetDescriptor`; making `ExecutionResult.groupSizes` required; and a way for `PaymentProvider` to report that a session is open, expired or complete. Without the last one, checkout retries rely on the `checkout.session.expired` webhook to move expired sessions to `payment_failed`.
