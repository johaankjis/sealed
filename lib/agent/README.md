# lib/agent — backend orchestration (owner: Claude Code)

Job lifecycle, Claude code generation, and the paid-query execution loop.
Everything external is injected through `contracts/` interfaces, so this module
has no direct dependency on Stripe, CreateOS, or the security policy code.

## Modules
- `stateMachine.ts`: allowed `JobStatus` transitions.
- `jobStore.ts`: `JobStore` interface with an atomic `transition(id, from, to)`, plus `InMemoryJobStore` for the MVP.
- `datasets.ts`: `DatasetDescriptor` (schema, table name, price) and `StaticDatasetCatalog`.
- `codegen.ts`: `ClaudeCodeGenerator` calls the Messages API with a forced `submit_analysis` tool and returns `{ code, summary, chartType }`.
- `codeCheck.ts`: pre-flight denylist/allowlist for generated Python. This is defence in depth, not a security boundary.
- `orchestrator.ts`: `createJob`, `startCheckout`, `confirmPayment`, `failPayment`, `executeJob`.

## Wiring (for the integration owner / API routes)

```ts
import { ClaudeCodeGenerator, InMemoryJobStore, StaticDatasetCatalog,
  createJob, startCheckout, confirmPayment, executeJob } from "@/lib/agent";

const deps = {
  store: new InMemoryJobStore(),          // module-level singleton
  datasets: new StaticDatasetCatalog([...]),
  payments,                                // PaymentProvider from lib/payments
  sandbox,                                 // SandboxRuntime from lib/sandbox
  policy,                                  // OutputPolicy from lib/security
  codegen: new ClaudeCodeGenerator(),      // needs ANTHROPIC_API_KEY
  options: { timeoutMs: 60_000, maxRetries: 2 },
  onEvent: (e) => {/* security activity feed */},
};

// POST /api/jobs           -> createJob(deps, { datasetId, question })
// POST /api/jobs/:id/pay   -> startCheckout(deps, id) -> redirect to checkoutUrl
// Stripe webhook (after signature check):
//   checkout.session.completed -> confirmPayment(deps, session.id) then executeJob(deps, job.id)
//   checkout.session.expired   -> failPayment(deps, session.id)
// GET /api/jobs/:id        -> store.get(id); return only status, result, errorCode
```

`executeJob` is idempotent: it re-verifies payment with the provider, then
atomically claims `paid -> running`, so duplicate webhooks run the job once.
It always destroys the snapshot, and it stores only the `ApprovedResult` that the
`OutputPolicy` returns. Raw sandbox output and errors go back to Claude as
truncated retry feedback and are never stored on the job.

## Env
- `ANTHROPIC_API_KEY` (required, server only)
- `SEALED_CLAUDE_MODEL` (optional, default `claude-sonnet-5-5`)

## Assumptions other agents need to match
- **Sandbox (Codex):** generated code expects a pre-defined DuckDB connection `con`
  with the dataset table loaded. It prints one JSON line,
  `{columns, rows, groupSizes}`, which `execute()` parses into `ExecutionResult`.
  If the runtime differs, pass `runtimeContract` to `ClaudeCodeGenerator`.
- **Security (GLM):** `OutputPolicy.validate` must return `result` when approved.
  `executeJob` overrides `summary`/`chartType` with the model's values (the model
  never sees data). If the policy throws, the job fails closed.
- **Payments (Antigravity):** `verifyPayment` must return the `jobId` the session
  was created for, because `executeJob` checks that it matches.

## Not yet done
- Postgres `JobStore` (use `UPDATE ... WHERE id=$1 AND status=$2 RETURNING *`).
- The timeout only abandons the promise; the sandbox must enforce its own kill.
