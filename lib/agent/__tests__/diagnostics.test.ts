import { describe, expect, it } from "vitest";
import { SandboxError } from "../../sandbox/createos";
import { SHARED_SANDBOX_ID, type SingleSandboxConfig } from "../../sandbox/single";
import { diagnosticCode, withSharedSandboxDiagnostics, type SdkDiagnostic } from "../diagnostics";
import { createJob, executeJob, startCheckout, confirmPayment } from "../orchestrator";
import { assertExecutionConfigured, ConfigError, createSingleSandboxRuntime } from "../server";
import { SnapshotAuthorizer } from "../executionAuth";
import { InMemoryJobStore } from "../jobStore";
import { makeDeps } from "./fakes";

const SECRET = "sk-live-SECRET-should-never-appear";

describe("diagnosticCode", () => {
  it.each([
    [new SandboxError("SHARED_EGRESS_UNVERIFIED"), "SHARED_EGRESS_UNVERIFIED"],
    [new ConfigError("CREATEOS_SANDBOX_API_KEY"), "CONFIG:CREATEOS_SANDBOX_API_KEY"],
    [new ConfigError("SEALED_SHARED_SANDBOX_ID (must equal the sealed-runtime sandbox ID)"), "CONFIG:SEALED_SHARED_SANDBOX_ID"],
    [Object.assign(new Error(`bad key ${SECRET}`), { name: "AuthenticationError", status: 401 }), "AuthenticationError:401"],
    [Object.assign(new Error(SECRET), { name: "CreateosSandboxNotFoundError", statusCode: 404, code: "not_found" }), "CreateosSandboxNotFoundError:404:not_found"],
    [Object.assign(new Error("x"), { code: `https://host/${SECRET}` }), "Error"],
    [new TypeError(`fetch failed for ${SECRET}`), "TypeError"],
    ["string thrown", "UNKNOWN"],
  ])("redacts %s to %s", (err, expected) => {
    const code = diagnosticCode(err);
    expect(code).toBe(expected);
    expect(code).not.toContain("SECRET");
  });
});

describe("stage_failed events", () => {
  async function paidJob() {
    const ctx = makeDeps();
    const job = await createJob(ctx.deps, { datasetId: "retail", question: "Average order by region?" });
    const { sessionId } = await startCheckout(ctx.deps, job.id);
    await confirmPayment(ctx.deps, sessionId);
    return { ...ctx, jobId: job.id };
  }

  it("reports the prepare stage and sandbox code instead of swallowing it", async () => {
    const { deps, events, jobId } = await paidJob();
    deps.sandbox.prepareDataset = async () => {
      throw new SandboxError("SHARED_ATTACHMENT_REJECTED");
    };
    const job = await executeJob(deps, jobId);
    expect(job.errorCode).toBe("sandbox_unavailable");
    expect(events).toContainEqual({ type: "stage_failed", jobId, stage: "sandbox_prepare", code: "SHARED_ATTACHMENT_REJECTED" });
    expect(events.at(-1)).toEqual({ type: "job_finished", jobId, status: "execution_failed", errorCode: "sandbox_unavailable" });
  });

  it("reports generation failures with a redacted code and no message", async () => {
    const { deps, events, jobId } = await paidJob();
    deps.options.maxRetries = 0;
    deps.codegen.queue = [Object.assign(new Error(`invalid x-api-key ${SECRET}`), { name: "AuthenticationError", status: 401 })];
    const job = await executeJob(deps, jobId);
    expect(job.errorCode).toBe("generation_failed");
    expect(events).toContainEqual({ type: "stage_failed", jobId, stage: "generation", code: "AuthenticationError:401", attempt: 1 });
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("reports execution and destroy failures", async () => {
    const { deps, events, jobId } = await paidJob();
    deps.options.maxRetries = 0;
    deps.sandbox.executeImpl = async () => {
      throw new SandboxError("SANDBOX_TIMEOUT");
    };
    deps.sandbox.destroy = async () => {
      throw new SandboxError("SHARED_RECONCILIATION_REQUIRED");
    };
    await executeJob(deps, jobId);
    expect(events).toContainEqual({ type: "stage_failed", jobId, stage: "sandbox_execute", code: "SANDBOX_TIMEOUT", attempt: 1 });
    expect(events).toContainEqual({ type: "stage_failed", jobId, stage: "sandbox_destroy", code: "SHARED_RECONCILIATION_REQUIRED" });
  });
});

describe("withSharedSandboxDiagnostics", () => {
  function sharedBox(overrides: Record<string, unknown> = {}) {
    return {
      id: SHARED_SANDBOX_ID,
      data: { status: "paused", ingress_enabled: false, created_by: "someone" },
      getEgress: async () => ({ egress: ["127.0.0.1:9"] }),
      files: { upload: async () => undefined },
      runCommand: async () => ({ result: { stdout: `row,${SECRET}`, stderr: SECRET, exit_code: 1 } }),
      ...overrides,
    };
  }

  it("logs attach status, failing calls and exit codes without payloads", async () => {
    const entries: SdkDiagnostic[] = [];
    const box = sharedBox({
      files: {
        upload: async () => {
          throw Object.assign(new Error(SECRET), { name: "CreateosSandboxTimeoutError" });
        },
      },
    });
    const client = withSharedSandboxDiagnostics({ getSandbox: async () => box }, (e) => entries.push(e));
    const attached = await client.getSandbox(SHARED_SANDBOX_ID, { timeoutMs: 1, retry: false });
    expect(attached.data).toBe(box.data);

    await attached.runCommand("python3", ["-I", "-c", 'print("BLOCKED")'], { timeoutMs: 1, retry: false });
    await expect(
      attached.files.upload(`/tmp/sealed-shared-uuid/sealed-analysis.py`, `print("${SECRET}")`, { timeoutMs: 1, retry: false })
    ).rejects.toThrow();

    expect(entries).toEqual([
      { op: "attach", outcome: "ok", status: "paused", ingress: false },
      { op: "command", outcome: "exit", kind: "egress_probe", exit: 1 },
      { op: "upload", outcome: "error", code: "CreateosSandboxTimeoutError", file: "sealed-analysis.py" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });

  it("logs attach failures by class and status", async () => {
    const entries: SdkDiagnostic[] = [];
    const client = withSharedSandboxDiagnostics(
      {
        getSandbox: async () => {
          throw Object.assign(new Error(SECRET), { name: "CreateosSandboxAuthError", statusCode: 401 });
        },
      },
      (e) => entries.push(e)
    );
    await expect(client.getSandbox(SHARED_SANDBOX_ID, { timeoutMs: 1, retry: false })).rejects.toThrow();
    expect(entries).toEqual([{ op: "attach", outcome: "error", code: "CreateosSandboxAuthError:401" }]);
  });
});

describe("execution readiness", () => {
  const single = {
    SEALED_SANDBOX_MODE: "single-synthetic",
    SEALED_SHARED_SANDBOX_ID: SHARED_SANDBOX_ID,
    CREATEOS_SANDBOX_API_KEY: "k",
    ANTHROPIC_API_KEY: "a",
  };

  it("accepts a complete single-synthetic configuration", () => {
    expect(assertExecutionConfigured(single)).toBe("single-synthetic");
  });

  it.each([
    [{ ANTHROPIC_API_KEY: "" }, "CONFIG:ANTHROPIC_API_KEY"],
    [{ CREATEOS_SANDBOX_API_KEY: undefined }, "CONFIG:CREATEOS_SANDBOX_API_KEY"],
    [{ SEALED_SHARED_SANDBOX_ID: "sb-someone-else" }, "CONFIG:SEALED_SHARED_SANDBOX_ID"],
    [{ SEALED_SANDBOX_MODE: "shared" }, "CONFIG:SEALED_SANDBOX_MODE"],
    [{ SEALED_SANDBOX_MODE: "snapshot-fork" }, "CONFIG:SEALED_CREATEOS_SHAPE"],
  ])("refuses %o", (override, code) => {
    expect(() => assertExecutionConfigured({ ...single, ...override })).toThrow(ConfigError);
    try {
      assertExecutionConfigured({ ...single, ...override });
    } catch (err) {
      expect(diagnosticCode(err)).toBe(code);
    }
  });

  it("tolerates whitespace around the mode and shared ID but still requires the exact ID", () => {
    const env = { ...single, SEALED_SANDBOX_MODE: " single-synthetic\r", SEALED_SHARED_SANDBOX_ID: `${SHARED_SANDBOX_ID}\r\n` };
    expect(assertExecutionConfigured(env)).toBe("single-synthetic");
    const client: SingleSandboxConfig["client"] = { getSandbox: async () => Promise.reject(new Error("unused")) };
    expect(() => createSingleSandboxRuntime(new SnapshotAuthorizer(new InMemoryJobStore()), env, client)).not.toThrow();
    expect(() =>
      createSingleSandboxRuntime(
        new SnapshotAuthorizer(new InMemoryJobStore()),
        { ...env, SEALED_SHARED_SANDBOX_ID: `${SHARED_SANDBOX_ID}x` },
        client
      )
    ).toThrow("SHARED_MODE_NOT_ENABLED");
  });
});
