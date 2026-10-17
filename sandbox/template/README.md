# Python / DuckDB CreateOS template

Proposed alias: `sealed-python-duckdb-1-5-4`.
**No verified template name or ID exists. No build was submitted.**

## Preflight result — 2026-10-17

Used only the existing CreateOS login, not Stripe Projects. Read-only checks:

- CLI v0.0.31 exposes `sandbox template submit/list/show/logs/rm`.
- `createos whoami` and the account endpoint report `free-plan`.
- The same account's dashboard showed **3,484.95 Credits Left** at inspection.
  This is a point-in-time balance; its existing VM continues consuming credits.
- `createos sandbox template list` returned an empty list.
- Sandbox SDK `whoami()` returned running=1, paused=0, other=0, total=8.
  The active VM is the preexisting `sealed-test`; it was not changed or deleted.
- Published Free-plan quotas are 0 concurrent / 0 daily templates, and 1
  concurrent / 10 daily sandboxes. Lifetime `total=8` is not a daily quota count.
- The dashboard's Create Template form displayed **Upgrade plan**, confirming
  that the present account cannot submit a template despite its credit balance.

The user required support/quota/credit verification before creating resources.
Therefore **zero templates and zero test VMs were created**. No build or new-VM
charges were incurred by this task. No plan upgrade or credit purchase was made.
Exact future template-build charges are not established; the general pricing
page's “Template Listing” fee is not evidence of a sandbox-image build price.

Live template import and restrictive-egress checks are **blocked**, not passed.
Prior tests of DuckDB 1.5.4 in an existing VM do not verify this unbuilt template.

## Definition

`Dockerfile` uses the Debian base currently suggested by the CreateOS form,
installs Python and GNU timeout, creates an isolated Python environment, and
pins DuckDB to 1.5.4. A wrapper at `/usr/local/bin/python3` ensures the runtime's
`python3 -I` command uses that environment without relying on Docker ENV metadata
being applied when an image becomes a microVM rootfs. The provider's boot/agent
configuration is retained. No data, credentials, or generated analysis is baked in.

The Dockerfile has one FROM, no COPY/ADD, no variable in FROM, and is below 64 KiB.
Those documented submission constraints were checked locally. The build-time
DuckDB assertion remains unexecuted. The mutable base tag and OS package versions
mean this is a reusable definition, not a bit-for-bit reproducible image.

## Build once, only after the blocker is resolved

An account owner must enable sandbox-template entitlement and confirm its actual
quota and build pricing. Recheck credits and available sandbox slots through the
CreateOS account; never free a slot by deleting someone else's VM. Do not switch
accounts, purchase a plan, or use Stripe Projects credentials for this workflow.

Once entitlement and sufficient credits are confirmed, submit **at most once**:

```sh
createos sandbox template submit sealed-python-duckdb-1-5-4 \
  --file sandbox/template/Dockerfile --no-follow
createos sandbox template show <returned-template-id>
createos sandbox template logs <returned-template-id>
```

Keep the returned ID. If submission times out, list templates and reconcile
before any action; do not resubmit. If the build fails, collect logs and stop.
Only status `ready` establishes a usable template. A plan change or additional
build requires separate authorization; it is not an automatic recovery step.

## Test only a dedicated VM from the ready template

After checking quota and credit headroom, create one disposable VM. Record its
returned ID and use that exact ID in every remaining command. Leave ingress off.
The temporary positive-control allowlist permits only the probe destinations:

```sh
createos sandbox create --name sealed-template-test \
  --shape s-1vcpu-1gb --rootfs sealed-python-duckdb-1-5-4 \
  --egress pypi.org:443 --egress 1.1.1.1:443 --egress 1.1.1.1:53
createos sandbox push <test-id> sandbox/template/verify_template.py /tmp/verify-template.py
createos sandbox exec <test-id> -- timeout --foreground --signal=KILL 60s \
  python3 -I /tmp/verify-template.py baseline
```

The probe checks the exact DuckDB version and a synthetic SQL result inside the
VM, plus hostname TCP, direct IPv4/IPv6 TCP, and direct UDP DNS connectivity.
Hostname TCP and direct IPv4 must succeed in the baseline, otherwise the test
is inconclusive and exits nonzero. IPv6 is exploratory under this IPv4 allowlist.

Replace the test VM's allowlist with `127.0.0.1:9` and read it back. Allow policy
propagation before probing. Do not use an empty list: that permits all egress.
The following syntax was checked against CLI v0.0.31:

```sh
createos sandbox firewall set <test-id> 127.0.0.1:9
createos sandbox firewall show <test-id>
createos sandbox exec <test-id> -- timeout --foreground --signal=KILL 60s \
  python3 -I /tmp/verify-template.py restricted
createos sandbox rm <test-id> --force
createos sandbox get <test-id>
```

Always clean up this exact test ID, including after failure, and verify status
`destroyed`; `destroying` is not completion. Keep the reusable template. The
script never modifies firewall rules or deletes resources itself.

A passing probe demonstrates blocked access to the tested reachable endpoints,
not comprehensive zero egress. Internal resolvers, arbitrary destinations and
protocols, metadata services, and private networks are not exhaustively covered.
Report missing positive controls explicitly. Do not use customer data here.

When both the template and enforcement checks pass, configure the existing
runtime's `rootfs` with the verified alias and keep its production isolation
verification callback. Do not configure the proposed, unbuilt name yet.

## Sources

- [CreateOS CLI reference](https://createos.sh/docs/CLI/Command-Reference/)
- [Template API restrictions and lifecycle](https://createos.sh/docs/Sandbox/REST-API/Templates/)
- [Plan quotas](https://createos.sh/docs/Sandbox/Limits/)
- [Egress policy](https://createos.sh/docs/Sandbox/REST-API/Egress/)
- [General billing](https://createos.sh/docs/Account-Billing/Pricing/)

Local checks: Dockerfile structural validation, Python syntax parsing, and
synthetic tests of the probe's verdict function. No local DuckDB installation,
SQL execution, or network probe was performed.
