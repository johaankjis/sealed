# Temporary synthetic single-sandbox mode

`lib/sandbox/single.ts` implements the existing `SandboxRuntime` contract using
only `getSandbox` attachment to `sealed-runtime`
(`sb-01m563ts9ekxrv0q85yptqsrh7`) in the credited account. It never creates,
forks, pauses, or destroys a VM. Existing `CreateOSRuntime` snapshot/fork behavior
is unchanged. No plan upgrade or additional VM is required.

## Integration setup

The orchestration owner must opt in at the composition root; that file has not
been modified. Use `singleSandboxFromEnv(config)` when selecting this mode:

```dotenv
SEALED_SANDBOX_MODE=single-synthetic
SEALED_SHARED_SANDBOX_ID=sb-01m563ts9ekxrv0q85yptqsrh7
CREATEOS_SANDBOX_API_KEY=<server-only key for the credited CreateOS account>
```

Inject the SDK 0.8.2 client created with `createClient({apiKey, retry:false})`.
Supply `syntheticDatasets` from a server-maintained registry mapping dataset IDs
to reviewed synthetic CSV SHA256 digests and catalog table names. Do not compute
this allowlist from arbitrary incoming uploads or accept it from buyers.
Bind `authorizeExecution(handle)` to the existing verified-payment job authorizer.
The returned handle is a per-job UUID, not a provider sandbox ID. Always finalize
with `destroy(handle)`; this removes only that job's temporary files. Results
still require the existing independent output policy before buyer release.

The administrator must first configure the exact restrictive rule
`127.0.0.1:9`. The runtime never silently changes network policy. Empty rules
mean unrestricted egress and are rejected. It checks authenticated account, ID,
running status, disabled ingress, policy readback, DuckDB version, and remote
negative TCP IPv4/IPv6/hostname and UDP DNS probes before upload and execution.
Probes provide evidence for those destinations, not proof of zero egress.

## Lifecycle and limits

Only one prepared job can hold the sandbox at a time, across runtime instances.
An atomic remote `mkdir` lease also excludes cooperating workers in other host
processes. Busy jobs fail closed; orchestration should serialize scheduling.
Each attempt is single-use. A new attempt requires a new prepare lifecycle.
Timeouts are enforced by a remote Python supervisor, which kills the analysis
process group on both normal exit and timeout. The host request allows 10 extra
seconds. Temporary output is capped before returning; raw diagnostics never
reach the result. Cleanup completes before a successful candidate is returned.

Transport ambiguity, lost supervisor acknowledgement, upload uncertainty, or
cleanup failure quarantines the lease. No automatic retries or lock stealing.
An operator must establish that remote processes are stopped and remove only
this mode's known job directory and `/tmp/sealed-shared.lock` before restarting
the worker. Never destroy the shared VM to recover a lease.

This is a cooperative synthetic demo mode, **not isolation for hostile code or
private customer data**. Code shares a guest UID and can deliberately escape a
process group, modify runtime files or leave persistent changes. Secure hostile
multi-tenant execution remains blocked without provider isolation or a stronger
remote supervisor. Do not use this mode for customer datasets. No SDK method
for filesystem removal is assumed: trusted remote Python performs scoped cleanup.

Remote DuckDB 1.5.4 is installed under
`/root/.local/lib/python3.13/site-packages`; `python3 -I` excludes it by default.
This mode explicitly adds that verified path in its probe and uploaded runner.
No DuckDB installation or generated Python execution occurs on the host.

## Verification

`npm run typecheck` and `npm test` cover the existing runtime and shared-mode
mock tests. The opt-in live test attaches to the existing VM only:

```sh
# Uses an already authenticated credited-account CLI login; never Stripe Projects.
SEALED_SINGLE_LIVE=1 npm test -- lib/sandbox/single-live.test.ts
```

This test uses a three-line synthetic CSV, checks SQL SUM, an infinite-loop
remote timeout, temporary-file cleanup and that the same VM remains running.
The synthetic authorization stub in this test must never be used in production.
SDK attachment and firewall readback were verified live on 2026-10-17. The
firewall was restricted to `127.0.0.1:9` and left restrictive after testing.
No additional resources were created; provider execution charges were not
available from the SDK response and are not claimed to be zero.

Live result: **passed**, 34.44 seconds on 2026-10-17. Aggregation returned 3,
the infinite loop raised `SANDBOX_TIMEOUT`, both job directories and the lease
were absent afterwards, and the existing sandbox remained `running`. All four
pre-upload/pre-execution network probes passed with the restrictive policy.
The initial live attempts exposed and fixed isolated-Python user-site lookup
and reuse of the same runtime for a second sequential lifecycle.

Remaining integration work: the orchestration owner must select the opt-in
factory, provide the reviewed synthetic digest registry and preserve payment
and output-policy wiring. Real Claude API generation was not invoked: the live
test verifies compatible generated-Python structure with synthetic SQL only.
