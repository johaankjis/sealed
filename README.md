# Sealed

Sealed is a private-data insights marketplace that lets buyers pay for AI-generated answers without exposing the underlying dataset. The repository implements the MVP architecture for a product where questions are answered in isolated sandboxed execution environments, and only validated aggregate results are returned to the buyer.

## Product vision

- Buyers can browse datasets and ask a question.
- A flat-fee checkout flow verifies payment before execution begins.
- An AI agent generates analysis code restricted to aggregate, privacy-safe output.
- The analysis runs in an isolated CreateOS sandbox against a dataset snapshot.
- Buyer-facing results are limited to approved, aggregate outputs.

## Architecture at a glance

Sealed combines a Next.js app, a backend execution pipeline, and isolated sandbox execution:

- Next.js + TypeScript frontend and API
- Stripe for checkout and payment verification
- Anthropic Claude for code generation
- CreateOS sandbox runtime for isolated Python/DuckDB execution
- PostgreSQL-backed application state
- Output validation and privacy policy enforcement before results are shown

The design is documented in more detail in `docs/ARCHITECTURE.md`.

## Repository layout

- `app/` — Next.js App Router pages and UI
- `components/` — reusable frontend components and dataset presentation
- `contracts/` — shared interfaces and contracts between services
- `lib/` — application logic, agent orchestration, sandbox integration, security rules, and payment code
- `sandbox/` — sandbox integration, runner scripts, smoke checks, and templates
- `docs/` — architecture and design notes
- `package.json` — project scripts and dependencies

## Key flows

1. A buyer selects a dataset and asks a question.
2. The app creates a paid job and starts Stripe checkout.
3. Payment verification gates execution.
4. An agent generates restricted Python analysis code.
5. The code runs in an isolated sandbox on a dataset snapshot.
6. Results pass validation and only approved aggregate outputs are returned.
7. The sandbox is destroyed after execution.

## Current status

This repository is structured as an MVP / prototype implementation for the marketplace and sandbox execution flow. It includes the application shell, the sandbox orchestration logic, and design documentation for safe execution practices.

Important note: the security model is intentionally conservative. The project documents the need to verify network egress restrictions and privacy policies before claiming real-world guarantees.

## Local development

### Prerequisites

- Node.js 20+ recommended
- npm

### Install dependencies

```bash
npm install
```

### Run the app in development mode

```bash
npm run dev
```

### Production build

```bash
npm run build
```

### Type-checking

```bash
npm run typecheck
```

### Tests

```bash
npm test
```

## Scripts

The root package includes the following scripts:

- `npm run dev` — start the Next.js development server
- `npm run build` — produce a production build
- `npm run start` — serve the built app
- `npm run typecheck` — run TypeScript checks without emitting output
- `npm test` — run the Vitest suite

## Security and privacy posture

This project is designed around the principle that raw customer data should not be exposed to buyers. The implemented and documented design enforces several boundaries:

- buyer-generated code runs in isolated execution sandboxes
- execution is tied to a paid job state
- aggregate-only output is preferred
- validation checks should reject unsafe or overly revealing results
- the sandbox lifecycle includes teardown and cleanup

The architecture docs explicitly note that some egress and privacy guarantees must be empirically verified before they are presented as fully enforced guarantees.

## Documentation

- `docs/ARCHITECTURE.md` — core architecture and execution lifecycle
- `sandbox/README.md` — sandbox integration notes and runtime wiring
- `lib/agent/README.md` — agent behavior and safety constraints
- `lib/payments/README.md` — payment integration notes
- `lib/security/README.md` — security and policy notes

## Contributing

This repo is organized around small, agent-owned service areas. Keep changes targeted and aligned with the architecture described in `AGENTS.md` and `docs/ARCHITECTURE.md`.

## License

This repository does not currently include a license file. If you intend to distribute or reuse this code publicly, add an explicit open-source license before publishing.
