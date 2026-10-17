# Sealed — Multi-Agent Engineering Rules

## Mission
Build Sealed, a private-data insights marketplace.
Buyers pay for AI-generated insights. The underlying
datasets remain inside isolated CreateOS sandboxes.

## Architecture
- Next.js + TypeScript: frontend and API
- CreateOS: sandboxed Python execution
- DuckDB: private dataset queries
- Claude API: code generation
- Stripe: Checkout, webhooks, Connect
- PostgreSQL: application state

## Agent ownership
- Claude Code: lib/agent, backend orchestration
- Codex: lib/sandbox, sandbox/
- Muse: app/, components/
- OpenCode GLM: lib/security, security tests
- Antigravity: lib/payments, Stripe integration

## Mandatory rules
1. Work only inside your assigned Git worktree.
2. Commit changes to your own agent branch.
3. Never merge directly into main.
4. Never modify contracts/ without approval.
5. Never modify another agent's owned files.
6. Never commit secrets, tokens, or .env files.
7. Use TypeScript for application code.
8. Use Python for sandbox execution.
9. Use shared interfaces from contracts/.
10. Document any missing SDK functionality.
11. Do not invent CreateOS or Stripe SDK methods.
12. Do not provision paid resources without approval.
13. Keep changes small and testable.
14. Do not bypass payment verification or output checks.

## Security boundaries
- Buyer-generated code runs only in CreateOS.
- API secrets stay outside buyer execution environments.
- Raw customer data must never appear in buyer responses.
- Unvalidated stdout, stderr, logs, and files must not
  be exposed to buyers.
- No execution of paid queries before verified payment.
- Every query should have an isolated execution lifecycle.
- Do not claim zero egress without demonstrating enforcement.

## Integration
The human integration owner controls main.
Agents should communicate interface changes rather than
editing each other's files.

## Definition of done
- Code builds successfully
- Relevant tests pass
- No secrets are committed
- Changes are committed to the agent branch
- Integration instructions are documented
