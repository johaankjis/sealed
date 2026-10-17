# lib/security

Security primitives for Sealed. Owned by the OpenCode GLM agent.
Everything here is pure TypeScript with no SDK or network
dependencies, and it builds only on shared interfaces from
`contracts/` (`OutputPolicy`, `ExecutionResult`, `QueryJob`).

## Modules

| Module | Purpose | Intended caller |
| --- | --- | --- |
| `output-policy.ts` | `AggregateOnlyOutputPolicy` — implements `contracts/results.ts` `OutputPolicy`. Enforces aggregate-only output, minimum group size (k-anonymity), row/column/cell limits, and blocks identifier or sensitive columns and email-shaped values. | lib/agent, before a result is marked `completed` |
| `code-policy.ts` | `validateGeneratedCode` — static checks on Claude-generated Python before it reaches CreateOS. Module allowlist, banned constructs, and blocked DuckDB network/export surfaces. | lib/agent, inside the generation retry loop |
| `query-policy.ts` | `validateQuestion` — buyer input hygiene at the API boundary; rejects NUL bytes, oversized input, and obvious raw-data dump requests. | app API routes / lib/agent job creation |
| `execution-gate.ts` | `canExecuteJob` — refuses to let a job execute unless status is `paid` **and** a verified Stripe session reference is present. Prevents pre-payment execution and re-execution. | lib/agent, before claiming a job |
| `redaction.ts` | `redactExecutionOutput` — scrubs emails, secrets, SSN/phone/digit shapes and control characters from unvalidated stdout/stderr/logs and caps length. | lib/agent, lib/sandbox logging paths |

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

const policy = new AggregateOnlyOutputPolicy();
const decision = await policy.validate(executionResult); // ValidationDecision

const safeLogLine = redactExecutionOutput(stderr);
```

## Defaults

- `minGroupSize: 10` — every published group must represent at least 10 records.
- `maxRows: 200`, `maxColumns: 20`, `maxCellLength: 200`.
- Question length limit: 2000 characters.
- Execution output kept for display/logs: 4000 characters.

All are configurable via constructor/options parameters; defaults are
exported as `DEFAULT_*` constants.

## Threat-model mapping (AGENTS.md security boundaries)

- "Raw customer data must never appear in buyer responses" → `output-policy.ts`.
- "Unvalidated stdout, stderr, logs and files must not be exposed" → `redaction.ts`.
- "No execution of paid queries before verified payment" → `execution-gate.ts`.
- "Buyer-generated code runs only in CreateOS" → `code-policy.ts` (defense-in-depth in front of sandbox isolation, which lib/sandbox owns).
- "No unverified privacy guarantees" → this library makes no egress claims; see Limitations.

## Known limitations

1. **Group-size metadata is trusted, not derived.** If a sandbox omits
   `groupSizes`, the row cap is the only backstop. lib/sandbox should
   always emit `groupSizes`; a contract change to make it mandatory
   would need owner approval and is *not* included in this change.
2. **`validateQuestion` dump detection is heuristic.** It blocks obvious
   export phrasings but cannot guarantee intent. The output policy is
   the real enforcement layer.
3. **DuckDB keyword checks are case-sensitive** (`INSTALL`, `LOAD`,
   `ATTACH`, `COPY … TO`) to avoid false-positives on ordinary Python
   words; anything that slips through is sandbox isolation's concern.
4. **Network egress enforcement is not implemented here.** Verifying
   restricted networking requires CreateOS support (lib/sandbox
   territory). Do not claim zero-egress anywhere in the product until
   that is empirically demonstrated.

## Tests

```
npm test            # runs everything vitest discovers
npx vitest run lib/security   # just these tests
```
