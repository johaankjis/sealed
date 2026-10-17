# Sealed — System Architecture

## Core concept
A marketplace where buyers pay for insights generated
from private business datasets without receiving the
underlying dataset.

## Query lifecycle

1. Buyer submits question.
2. Backend creates job.
3. Stripe Checkout session is created.
4. Stripe webhook verifies successful payment.
5. Backend atomically claims paid job for execution.
6. Claude generates restricted Python analysis code.
7. CreateOS starts isolated execution from dataset snapshot.
8. Generated code executes against DuckDB.
9. Execution produces structured result data.
10. Server-side policy validates result.
11. Approved result becomes available to buyer.
12. Execution sandbox is destroyed.

## Components

Frontend:
- Next.js App Router
- Marketplace and dataset pages
- Checkout and job status
- Charts and security activity

Backend:
- Next.js server routes
- Job state machine
- Claude code-generation and retry loop
- Database persistence

Execution:
- CreateOS sandboxes
- Python + DuckDB
- Dataset snapshots and per-query isolation
- Restricted networking (must be verified)

Security:
- No direct buyer access to sandbox output
- Aggregate
cat > docs/ARCHITECTURE.md <<'EOF'
# Sealed — System Architecture

## Core concept
A marketplace where buyers pay for insights generated
from private business datasets without receiving the
underlying dataset.

## Query lifecycle

1. Buyer submits question.
2. Backend creates job.
3. Stripe Checkout session is created.
4. Stripe webhook verifies successful payment.
5. Backend atomically claims paid job for execution.
6. Claude generates restricted Python analysis code.
7. CreateOS starts isolated execution from dataset snapshot.
8. Generated code executes against DuckDB.
9. Execution produces structured result data.
10. Server-side policy validates result.
11. Approved result becomes available to buyer.
12. Execution sandbox is destroyed.

## Components

Frontend:
- Next.js App Router
- Marketplace and dataset pages
- Checkout and job status
- Charts and security activity

Backend:
- Next.js server routes
- Job state machine
- Claude code-generation and retry loop
- Database persistence

Execution:
- CreateOS sandboxes
- Python + DuckDB
- Dataset snapshots and per-query isolation
- Restricted networking (must be verified)

Security:
- No direct buyer access to sandbox output
- Aggregate-only result validation
- Minimum group-size policy
- Identifier and sensitive-column restrictions
- Query and result size limits
- Bounded execution time
- No unverified privacy guarantees

Payments:
- Stripe Checkout
- Verified webhook signatures
- Idempotent job execution
- Stripe Connect integration

## MVP success criteria

One buyer can pay for a question, have an agent
generate and execute Python inside CreateOS, and
receive a validated chart or table.

An unsafe data request must be rejected.

Network exfiltration controls must be empirically
verified before presenting them as enforced guarantees.
