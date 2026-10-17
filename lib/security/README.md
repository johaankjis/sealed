# lib/security

Security primitives for Sealed. Owned by the OpenCode GLM agent.
Everything here is pure TypeScript with no SDK or network
dependencies, and it builds only on shared interfaces from
`contracts/` (`OutputPolicy`, `ExecutionResult`, `QueryJob`).

## Modules

| Module | Purpose | Intended caller |
| --- | --- | --- |
| `output-policy.ts` | `AggregateOnlyOutputPolicy` — implements `contracts/results.ts` `OutputPolicy`. **Fails closed**: rejects results without trusted group-size evidence, enforces minimum group size (k-anonymity), aggregate-only output, row/column/cell limits, blocks identifier/sensitive columns, detects fabricated size claims, and rejects overlapping drill-down/probe query patterns. | lib/agent, before a result is marked `completed` |
| `code-policy.ts` | `validateGeneratedCode` — static checks on Claude-generated Python before it reaches CreateOS. Module allowlist, banned constructs, and blocked DuckDB network/export surfaces. | lib/agent, inside the generation retry loop |
| `query-policy.ts` | `validateQuestion` — buyer input hygiene at the API boundary; rejects NUL bytes, oversized input, and obvious raw-data dump requests. | app API routes / lib/agent job creation |
| `execution-gate.ts` | `canExecuteJob` — refuses to let a job execute unless status is `paid` **and** a verified Stripe session reference is present. Prevents pre-payment execution and re-execution. | lib/agent, before claiming a job |
| `redaction.ts` | `redactExecutionOutput` — scrubs emails, secrets, SSN/phone/digit shapes and control characters from unvalidated stdout/stderr/logs and caps length. | lib/agent, lib/sandbox logging paths |

## Output policy: fail-closed behavior

`AggregateOnlyOutputPolicy` publishes a result **only** when every
check passes. There is no fallback path. A result is rejected when:

- `groupSizes` is missing, null, malformed, or its length differs
  from the row count. **Group-size evidence is mandatory.** Without
  per-group record counts there is no way to distinguish a real
  aggregate from a raw dump or a single-customer row.
- Any group represents fewer than `minGroupSize` records (default k=10).
- `groupSizes` are internally inconsistent (total coverage smaller
  than the number of published rows).
- The result includes a row-count column (`count`, `record_count`,
  `rows`, …) whose values disagree with the reported `groupSizes` —
  treated as fabricated evidence, both claims are untrustworthy.
- Rows/columns/cells exceed the configured caps, or a result fills
  the entire row cap exactly (likely truncated dump).
- Any column name tokenizes to an identifier/sensitive token
  (`email`, `customer`, `user`, `account`, `id`, `device`, `ip`, …),
  ends in `_id`/`_uuid`/`_guid`/`_hash`, or matches a
  person-name shape (`first_name`, …).
- Any string cell is oversized, contains control characters, or is
  email-shaped.

## Overlapping-query detection

`AggregateOnlyOutputPolicy` instances are **stateful**: approved
results are remembered (bounded FIFO, default 20) so that
intersection/differential attacks across paid queries are rejected:

- **Drill-down chains** — repeatedly refining the same dimension
  slice (`month` → `month,region` → `month,region,age` → …) is
  capped at `maxRefinementDepth` refinements (default 2). The
  base-slice and total-then-grouped happy paths are unaffected.
- **Slice probing** — a query with the same column set that narrows
  a previously approved slice (strict subset of its dimension keys)
  is rejected (`rejectSliceProbing`, default on). Broadening a slice
  and exact repeats are allowed (idempotent re-fetch).

Scope note: the ledger lives on the policy instance. Callers should
instantiate one policy per buyer (or per dataset) so overlap history
is meaningful; a fresh instance per job disables overlap detection.

## Other modules' behavior

- `validateQuestion` strips control characters, enforces a 2000-char
  limit, and rejects obvious raw-dump phrasings. Heuristic only —
  the output policy is the enforcement layer.
- `validateGeneratedCode` allows only `{duckdb, math, statistics,
  decimal, datetime, json, re, itertools, collections}`, bans
  dynamic execution / introspection / filesystem / env access, and
  blocks DuckDB network and export surfaces (`ATTACH`, `COPY … TO`,
  `httpfs`, URLs, `CREATE SECRET`). SQL keyword checks are
  case-sensitive to avoid false positives on ordinary Python words.
- `canExecuteJob` allows execution only from `paid` status with a
  present `stripeSessionId`; every other status is rejected.
- `redactExecutionOutput` masks email/secret/SSN/phone/long-digit
  shapes, strips control characters (including ANSI escapes), and
  truncates to 4000 characters.

## Usage

```ts
import {
  AggregateOnlyOutputPolicy,
  canExecuteJob,
  redactExecutionOutput,
  validateGeneratedCode,
  validateQuestion,
} from "@/lib/security";

const gate = canExecuteJob(job);
if (!gate.allowed) return; // do not touch sandbox or model budget

const codeCheck = validateGeneratedCode(generatedPython);
if (!codeCheck.allowed) return regenerate(codeCheck.violations);

// one instance per buyer so overlap detection has history
const policy = new AggregateOnlyOutputPolicy();
const decision = await policy.validate(executionResult); // ValidationDecision

const safeLogLine = redactExecutionOutput(stderr);
```

## Defaults

All configurable via constructor options; exported as
`DEFAULT_OUTPUT_POLICY_OPTIONS`:

- `minGroupSize: 10`, `maxRows: 200`, `maxColumns: 20`, `maxCellLength: 200`
- `rejectRowCapSaturation: true`
- `maxRefinementDepth: 2`, `rejectSliceProbing: true`, `maxTrackedResults: 20`

`DEFAULT_QUESTION_POLICY_OPTIONS.maxLength` is 2000;
`DEFAULT_REDACTION_OPTIONS.maxLength` is 4000.

## Threat-model mapping (AGENTS.md security boundaries)

- "Raw customer data must never appear in buyer responses" → `output-policy.ts`.
- "Unvalidated stdout, stderr, logs and files must not be exposed" → `redaction.ts`.
- "No execution of paid queries before verified payment" → `execution-gate.ts`.
- "Buyer-generated code runs only in CreateOS" → `code-policy.ts` (defense-in-depth in front of sandbox isolation, which lib/sandbox owns).
- "No unverified privacy guarantees" → the policy fails closed on
  unverifiable evidence and this library makes no egress claims.

## Known limitations (and contract requests)

1. **Group sizes are self-reported by the sandbox.** The policy
   verifies internal consistency and cross-checks row-count columns,
   but cannot verify `groupSizes` against ground truth. **Contract
   request (needs owner approval, not made here):** make `groupSizes`
   mandatory in `contracts/results.ts` `ExecutionResult` (it is
   currently optional), and consider a sandbox-signed size
   attestation field so evidence is verifiable rather than
   self-reported.
2. **`ExecutionResult` carries no query metadata** (predicates,
   filters), so differential/probing detection is limited to column
   sets and dimension-key shapes. **Contract request:** an optional
   query-fingerprint field would enable stronger overlap detection.
3. **Overlap memory is per policy instance** (see scope note above);
   the caller decides instance lifetime. This is a documentation
   contract, not an enforced one.
4. **Dimensions are detected as non-numeric columns.** Adversarial
   code could encode a dimension numerically to evade chain/probing
   detection; k-anonymity and size checks still apply to those rows.
5. **`validateQuestion` dump detection is heuristic** and may
   over-block unusual phrasings; the output policy is the real
   backstop.
6. **Network egress enforcement is not implemented here.** Verifying
   restricted networking requires CreateOS support (lib/sandbox
   territory). Do not claim zero-egress anywhere in the product until
   that is empirically demonstrated.

## Tests

```
npm test            # runs everything vitest discovers
npx vitest run lib/security   # just these tests
```
