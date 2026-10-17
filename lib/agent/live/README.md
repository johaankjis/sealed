# Coffee live smoke test (manual, billable)

`coffee-live.ts` runs **one genuine Claude-generated analysis** of the synthetic
coffee dataset inside CreateOS. It goes through the real orchestrator
(`executeJob`), lib/sandbox's `CreateOSRuntime`, the agent's fail-closed
group-size check, and lib/security's `AggregateOnlyOutputPolicy`. It prints
JSON-line events and can write them to a report file.

It has **not been executed yet**. Running it creates CreateOS sandboxes, which
spend credits, and makes one Anthropic API call.

## Safety properties
- **Explicit opt-in.** Without `--run` it exits with status 2 before loading the
  SDK or contacting any service.
- **Synthetic data only.** The dataset is always the bundled
  `lib/agent/fixtures/downtown-coffee-sales.csv`. Before anything is created, the
  file is checked byte for byte against the seeded generator. `SEALED_DATA_DIR`
  must be unset.
- **Prepared image, restricted egress.** `SEALED_CREATEOS_ROOTFS` must name a
  template owned by the account with status `ready`, and DuckDB must be baked
  in. Built-in images such as `devbox:1` are refused. Nothing is installed at
  runtime. `SEALED_CREATEOS_EGRESS` must be non-empty (empty means allow all
  in CreateOS) and must not contain `*` or the probe host. Every VM and fork runs
  the real egress probe before any data or code is uploaded. The probe is
  evidence for one destination only, not a zero-egress guarantee.
- **No payment bypass in the app.** The script approves a single in-process
  synthetic session (`live_synthetic_<run id>`) through `SyntheticRunPayments`,
  which cannot create checkouts. Nothing outside `lib/agent/live/` imports this
  directory, and `__tests__/live.test.ts` enforces that. Web routes always verify
  payment with Stripe through lib/payments.
- **Bounded work.** One attempt (`maxRetries: 0`). The guest timeout comes from
  `SEALED_LIVE_TIMEOUT_MS` (default 30s, enforced with `timeout --signal=KILL`).
  Runtime and SDK retries are off.
- **Cleanup touches only this run's sandboxes.** Before creating anything, the
  script records every sandbox that already exists and aborts if it can't. Root
  VMs are named `sl-<8 random hex>-N`. Cleanup destroys tracked IDs, listed VMs
  with this run's prefix, and forks of either. Anything in the starting list,
  such as `sealed-test`, is never a target. Cleanup also runs on errors, SIGINT
  and SIGTERM. If it can't confirm deletion, the script exits non-zero and
  prints a recovery command.

## Configuration
| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Read by the Anthropic SDK; never logged |
| `CREATEOS_SANDBOX_API_KEY` | unless `--cli-auth` | Sandbox API key (`api.sb.createos.sh`). The Stripe Projects `CREATEOS_PLAN/PROJECT_*` keys are for the platform API and have not been confirmed to work here |
| `SEALED_CREATEOS_ROOTFS` | yes | Name or ID of a ready template with Python 3, DuckDB 1.5.4 and GNU `timeout` |
| `SEALED_CREATEOS_EGRESS` | yes | e.g. `127.0.0.1:9` (a placeholder rule that permits nothing useful) |
| `SEALED_CREATEOS_SHAPE` | no | Default `s-1vcpu-1gb` |
| `SEALED_LIVE_QUESTION` | no | Default: "Which drink categories earn the most revenue?" |
| `SEALED_LIVE_TIMEOUT_MS` | no | 1000-120000, default 30000 |
| `SEALED_LIVE_REPORT` | no | Path for the JSON event report (keep it outside the repo or review it before committing) |
| `SEALED_CLAUDE_MODEL` | no | Default `claude-sonnet-5-5` |
| `SEALED_EGRESS_PROBE_HOST` | no | Default `1.1.1.1`; must not be allowlisted |

`--cli-auth` uses the existing CreateOS CLI login (`~/.createos/.oauth`, sent as
`X-Access-Token`). Run `createos whoami` first to refresh it.

## Prerequisites (each needs approval; none done yet)
1. A sandbox credential: either confirm the CLI login, or create a sandbox API key.
2. Build the DuckDB template. A proposed Dockerfile is `python:3.13-slim` plus `pip install duckdb==1.5.4`:
   `createos sandbox template submit sealed-duckdb -f <Dockerfile>`, then
   `createos sandbox template show sealed-duckdb` until it reports `ready`.
3. An Anthropic API key in the shell environment, not in a file.

## Run
```sh
createos whoami   # refresh CLI login if using --cli-auth
ANTHROPIC_API_KEY=... \
SEALED_CREATEOS_ROOTFS=sealed-duckdb \
SEALED_CREATEOS_EGRESS=127.0.0.1:9 \
SEALED_LIVE_REPORT=/tmp/sealed-coffee-live.json \
node --experimental-transform-types lib/agent/live/coffee-live.ts --run --cli-auth
```
Expected: about 2 VMs (snapshot plus one fork) for 1-3 minutes. On success,
`job_finished` shows `status: "completed"` with the policy-approved aggregate,
and every `final_status` is `destroyed`. A policy rejection or execution failure
exits 1 but still cleans up.

## Recovery
If the run is killed hard or cleanup is incomplete, use the printed prefix:
```sh
node --experimental-transform-types lib/agent/live/coffee-live.ts --run --cli-auth --cleanup sl-1a2b3c4d
```
This destroys only sandboxes named with that prefix and their forks.
Check with `createos sandbox list`.
