import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateOSRuntime, parseExecutionResult, type CreateOSSandbox } from "./createos";

const candidate = { columns: ["total"], rows: [{ total: 42 }], groupSizes: [10] };
function box(id: string) {
  return {
    id, files: { upload: vi.fn().mockResolvedValue(undefined) },
    runCommand: vi.fn().mockResolvedValue({ result: {
      stdout: JSON.stringify(candidate), stderr: "private diagnostic", exit_code: 0,
    } }),
    pause: vi.fn().mockResolvedValue(undefined),
    waitUntilPaused: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn<(...args: unknown[]) => Promise<CreateOSSandbox>>(),
    destroy: vi.fn().mockResolvedValue(undefined),
    waitUntilDestroyed: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CreateOS lifecycle", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sealed-test-"));
    await writeFile(join(dir, "data.csv"), "region,total\nwest,42\n"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  function setup() {
    const parent = box("snapshot");
    const child = box("query");
    parent.fork.mockResolvedValue(child);
    const config = { client: { createSandbox: vi.fn().mockResolvedValue(parent) },
      shape: "test-shape", rootfs: "test-image", egress: ["127.0.0.1:9"],
      verifyIsolation: vi.fn().mockResolvedValue(undefined),
      authorizeExecution: vi.fn().mockResolvedValue(true) };
    const runtime = new CreateOSRuntime(config);
    return { parent, child, config, runtime,
      prepare: () => runtime.prepareDataset("dataset", join(dir, "data.csv")) };
  }

  it("snapshots trusted input, forks per execution, returns only structured data and cleans up", async () => {
    const { runtime, parent, child, config, prepare } = setup();
    const id = await prepare();
    expect(parent.pause).toHaveBeenCalledOnce();
    expect(config.client.createSandbox).toHaveBeenCalledWith({ shape: "test-shape",
      rootfs: "test-image", ingress_enabled: false, egress: ["127.0.0.1:9"] });
    expect(await runtime.execute(id, "result = {} ")).toEqual(candidate);
    expect(config.authorizeExecution).toHaveBeenCalledWith(id);
    expect(config.verifyIsolation).toHaveBeenCalledTimes(2);
    expect(child.runCommand).toHaveBeenCalledWith("timeout", ["--signal=KILL", "30s",
      "python3", "-I", "/tmp/sealed-runner.py"], { timeoutMs: 35000, retry: false });
    expect(child.destroy).toHaveBeenCalledOnce();
    expect(child.waitUntilDestroyed).toHaveBeenCalledOnce();
    await runtime.destroy(id);
    await runtime.destroy(id);
    expect(parent.destroy).toHaveBeenCalledOnce();
  });

  it("does not fork or execute before verified payment", async () => {
    const { runtime, parent, config, prepare } = setup();
    config.authorizeExecution.mockResolvedValue(false);
    await expect(runtime.execute(await prepare(), "pass")).rejects.toThrow("PAYMENT_REQUIRED");
    expect(parent.fork).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("does not upload data when network verification fails", async () => {
    const { parent, config, prepare } = setup();
    config.verifyIsolation.mockRejectedValue(new Error("private failure"));
    await expect(prepare()).rejects.toThrow("SANDBOX_PREPARATION_FAILED");
    expect(parent.files.upload).not.toHaveBeenCalled();
    expect(parent.destroy).toHaveBeenCalledOnce();
  });

  it.each(["command", "output", "upload", "isolation"])("cleans failed %s without leaking diagnostics", async failure => {
    const { runtime, child, config, prepare } = setup();
    const id = await prepare();
    if (failure === "command") child.runCommand.mockRejectedValue(new Error("SECRET"));
    if (failure === "output") child.runCommand.mockResolvedValue({ result: {
      stdout: "SECRET", stderr: "SECRET", exit_code: 0 } });
    if (failure === "upload") child.files.upload.mockRejectedValue(new Error("SECRET"));
    if (failure === "isolation") config.verifyIsolation.mockRejectedValue(new Error("SECRET"));
    await expect(runtime.execute(id, "pass")).rejects.toThrow(/^SANDBOX_EXECUTION_FAILED$|^INVALID_SANDBOX_RESULT$/);
    expect(child.destroy).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("retains failed cleanup for retry and withholds results", async () => {
    const { runtime, child, prepare } = setup();
    const id = await prepare();
    child.destroy.mockRejectedValueOnce(new Error("SECRET"));
    await expect(runtime.execute(id, "pass")).rejects.toThrow("SANDBOX_CLEANUP_FAILED");
    await expect(runtime.execute(id, "pass")).rejects.toThrow("SNAPSHOT_UNAVAILABLE");
    await runtime.destroy(id);
    expect(child.destroy).toHaveBeenCalledTimes(2);
  });

  it("recovers failed preparation cleanup through dispose", async () => {
    const { runtime, parent, config, prepare } = setup();
    config.verifyIsolation.mockRejectedValue(new Error("SECRET"));
    parent.destroy.mockRejectedValueOnce(new Error("SECRET"));
    await expect(prepare()).rejects.toThrow("SANDBOX_CLEANUP_FAILED");
    await expect(runtime.execute(parent.id, "pass")).rejects.toThrow("SNAPSHOT_UNAVAILABLE");
    await runtime.dispose();
    expect(parent.destroy).toHaveBeenCalledTimes(2);
  });

  it("blocks overlapping execution and destruction", async () => {
    const { runtime, config, prepare } = setup();
    const id = await prepare();
    let release!: (paid: boolean) => void;
    config.authorizeExecution.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const running = runtime.execute(id, "pass");
    await expect(runtime.execute(id, "pass")).rejects.toThrow("SNAPSHOT_UNAVAILABLE");
    await expect(runtime.destroy(id)).rejects.toThrow("SNAPSHOT_BUSY");
    release(true);
    await running;
    await runtime.dispose();
  });
});

describe("result envelope", () => {
  it("accepts valid contract values", () => {
    expect(parseExecutionResult(JSON.stringify(candidate))).toEqual(candidate);
  });
  it.each([
    { ...candidate, stdout: "secret" },
    { columns: ["x", "x"], rows: [] },
    { columns: ["x"], rows: [{ x: true }] },
    { columns: ["x"], rows: [{ y: 1 }] },
    { columns: ["x"], rows: [{ x: { secret: 1 } }] },
    { ...candidate, groupSizes: [] },
    { ...candidate, groupSizes: [-1] },
    { ...candidate, rows: Array(1001).fill({ total: 42 }) },
  ])("rejects malformed/unbounded envelopes", value => {
    expect(() => parseExecutionResult(JSON.stringify(value))).toThrow("INVALID_SANDBOX_RESULT");
  });
  it("rejects overflowing numbers and excessive bytes", () => {
    expect(() => parseExecutionResult('{"columns":["x"],"rows":[{"x":1e999}]}')).toThrow();
    expect(() => parseExecutionResult(" ".repeat(1_000_001))).toThrow();
  });
});
