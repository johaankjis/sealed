# Frontend ⇔ Backend integration (Muse slice)

The Muse worktree owns `app/` and `components/`. This note tells the
orchestration / payments agents exactly which endpoints the UI calls,
so backend routes can be built to match. No backend code lives here.

## Endpoints the UI calls (same origin)

### `POST /api/jobs`
Create a query job. Body: `{ datasetId: string, question: string }`.
- Success: `201` with a [`QueryJob`](../contracts/job.ts) (`status: "created"`).
- Validation failure: `400` with `{ error: string }`.

### `GET /api/jobs/:id`
Return the current [`QueryJob`](../contracts/job.ts), including `status`
and, once complete, the validated `result: ApprovedResult`.
- Unknown id: `404` with `{ error: string }`.
- The job page polls this every 2.5s until a terminal status
  (`completed`, `rejected`, `payment_failed`, `execution_failed`).

### `POST /api/checkout`
Body: `{ jobId: string }`. The backend prices the job server-side,
builds the [`CheckoutRequest`](../contracts/payments.ts), and returns the
[`CheckoutResponse`](../contracts/payments.ts) (`sessionId`, `checkoutUrl`).
The UI redirects the buyer to `checkoutUrl`.
- Unknown job: `404` with `{ error: string }`.

Stripe success/cancel URLs should point back at `/jobs/:id` so the
buyer lands on the polling status page after payment.

## What the UI renders

- Only `ApprovedResult` (`summary`, `columns`, `rows`, `chartType`) is
  ever rendered. Raw sandbox stdout/stderr/logs are never fetched or shown.
- `errorCode` (if present) is shown as an opaque reference string only.

## Suggested contract additions (needs approval, not implemented here)

1. A shared `Dataset` / catalog listing type — the UI currently uses a
   local fixture type in `components/datasets.ts`.
2. A `unitAmountCents` or price field on the job or dataset contract so
   the displayed price comes from the backend instead of fixtures.
