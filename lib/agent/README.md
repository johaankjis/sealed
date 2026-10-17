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
| `CREATEOS_SANDBOX_API_KEY` | yes | CreateOS SDK client (`createClient({ apiKey, retry: false })`) |
| `SEALED_CREATEOS_SHAPE` | yes | e.g. `s-1vcpu-1gb` |
| `SEALED_CREATEOS_ROOTFS` | yes | Trusted image with python3, DuckDB and GNU `timeout` |
| `SEALED_CREATEOS_EGRESS` | yes | Comma-separated, **non-empty** allowlist (empty means unrestricted) |
| `SEALED_EGRESS_PROBE_HOST` | no (default `1.1.1.1`) | Must be outside the allowlist; see below |
| `SEALED_DATA_DIR` | no (default `lib/agent/fixtures`) | Location of dataset CSVs |

If a required variable is missing, the route that needs it returns `503`. Job
creation and polling still work.

`verifyIsolation` runs a probe inside each sandbox, before any data or code is
uploaded, that tries a TCP connection to the probe host on port 443. Any result
other than `BLOCKED` aborts the run. This is evidence for one destination only,
not a zero-egress guarantee.

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

## Integration blockers
1. **No live end-to-end run yet.** That needs Stripe test keys, an Anthropic key, and a CreateOS image with DuckDB preinstalled. Codex installed DuckDB on the `sealed-test` VM, not in a reusable rootfs.
2. **Group-size provenance.** `groupSizes` are produced by generated code, so they can be forged within the row-count bound. True provenance needs the runner, or a server-authored query, to compute counts. That is a sandbox and contract change for Codex and GLM.
3. **Egress.** The probe is only partial evidence. Do not claim zero egress.
4. **Retries vs. Codex's "no replay" rule.** The sandbox has `maxRetries: 0`. The agent loop may run *new* generated code after a failure, up to 3 attempts per paid job. If the owners want strictly one execution per payment, set `options.maxRetries: 0` in `server.ts`.
5. **Persistence.** The `InMemoryJobStore` is lost on restart. Postgres should implement `transition` as `UPDATE ... WHERE id=$1 AND status=$2 RETURNING *`.
6. **Frontend catalog.** Only `downtown-coffee-sales` exists on the backend. The other listings in `components/datasets.ts` return `404` from `POST /api/jobs`.
7. **Webhook route** is missing (see above).
8. **Suggested contract additions** (not made): a shared `DatasetDescriptor`; making `ExecutionResult.groupSizes` required; and a way for `PaymentProvider` to report that a session is open, expired or complete. Without the last one, checkout retries rely on the `checkout.session.expired` webhook to move expired sessions to `payment_failed`.
