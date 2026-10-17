import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SingleSandboxRuntime, SHARED_SANDBOX_ID } from "./single";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });
async function setup() {
  const dir = await mkdtemp(`${tmpdir()}/sealed-test-`); dirs.push(dir);
  const path = `${dir}/data.csv`; await writeFile(path, "value\n1\n2\n");
  const box = {
    id: SHARED_SANDBOX_ID,
    data: { status: "running", ingress_enabled: false, created_by: "75ea01ff-cb7f-4ed2-83c1-825a842c3673" },
    getEgress: vi.fn(async () => ({ egress: ["127.0.0.1:9"] })),
    files: { upload: vi.fn(async () => {}) },
    runCommand: vi.fn(async (_cmd: string, args: string[], _options: unknown) => ({ result: {
      stdout: args[2].includes('print("BLOCKED")') ? "BLOCKED\n" : args[2].includes("subprocess.Popen") ? '{"columns":["total"],"rows":[{"total":3}]}' : "",
      stderr: "", exit_code: 0,
    } })),
  };
  const config = { client: { getSandbox: vi.fn(async () => box) }, syntheticDatasets: { test: {
    sha256: createHash("sha256").update("value\n1\n2\n").digest("hex"), tableName: "dataset",
  } }, authorizeExecution: vi.fn(async () => true), timeoutMs: 1000 };
  return { box, config, path, runtime: new SingleSandboxRuntime(config) };
}
describe("temporary shared runtime", () => {
  it("rejects unknown fixture bytes before attachment", async () => {
    const { runtime, path, config } = await setup();
    await expect(runtime.prepareDataset("private", path)).rejects.toThrow("SYNTHETIC_DATA_REQUIRED");
    expect(config.client.getSandbox).not.toHaveBeenCalled();
  });
  it("fails closed on unrestricted egress before upload", async () => {
    const { runtime, path, box } = await setup(); box.getEgress.mockResolvedValue({ egress: [] });
    await expect(runtime.prepareDataset("test", path)).rejects.toThrow("SHARED_EGRESS_UNVERIFIED");
    expect(box.files.upload).not.toHaveBeenCalled();
  });
  it("rejects a sandbox from another account", async () => {
    const { runtime, path, box } = await setup(); box.data.created_by = "wrong";
    await expect(runtime.prepareDataset("test", path)).rejects.toThrow("SHARED_ATTACHMENT_REJECTED");
    expect(box.files.upload).not.toHaveBeenCalled();
  });
  it("fails closed when authenticated attachment is unsupported", async () => {
    const { runtime, path, box, config } = await setup();
    config.client.getSandbox.mockRejectedValue(new Error("unsupported"));
    await expect(runtime.prepareDataset("test", path)).rejects.toThrow("SHARED_PREPARATION_FAILED");
    expect(box.files.upload).not.toHaveBeenCalled();
  });
  it("rejects a failed remote network probe before upload", async () => {
    const { runtime, path, box } = await setup();
    box.runCommand.mockResolvedValue({ result: { stdout: "", stderr: "", exit_code: 1 } });
    await expect(runtime.prepareDataset("test", path)).rejects.toThrow("SHARED_EGRESS_UNVERIFIED");
    expect(box.files.upload).not.toHaveBeenCalled();
  });
  it("serializes across runtime instances and cleans only temporary files", async () => {
    const { runtime, path, box, config } = await setup();
    const handle = await runtime.prepareDataset("test", path);
    const other = new SingleSandboxRuntime(config);
    await expect(other.prepareDataset("test", path)).rejects.toThrow("SHARED_SANDBOX_BUSY");
    expect(await runtime.execute(handle, "result = {} ")).toEqual({ columns: ["total"], rows: [{ total: 3 }] });
    expect(box.runCommand.mock.calls.some(call => call[1][2].includes("shutil.rmtree"))).toBe(true);
    const next = await other.prepareDataset("test", path); await other.destroy(next);
  });
  it("checks payment before uploading generated code", async () => {
    const { runtime, path, box, config } = await setup();
    const handle = await runtime.prepareDataset("test", path); config.authorizeExecution.mockResolvedValue(false);
    await expect(runtime.execute(handle, "result = {} ")).rejects.toThrow("PAYMENT_REQUIRED");
    expect(box.files.upload.mock.calls).toHaveLength(3);
  });
  it("maps remote timeout and releases the lease after confirmed cleanup", async () => {
    const { runtime, path, box } = await setup();
    const handle = await runtime.prepareDataset("test", path);
    const original = box.runCommand.getMockImplementation()!;
    box.runCommand.mockImplementation(async (cmd, args, opts) => args[2].includes("subprocess.Popen")
      ? { result: { stdout: "", stderr: "", exit_code: 124 } } : original(cmd, args, opts));
    await expect(runtime.execute(handle, "while True: pass")).rejects.toThrow("SANDBOX_TIMEOUT");
    await runtime.destroy(handle);
    const next = await runtime.prepareDataset("test", path);
    await expect(runtime.execute(next, "while True: pass")).rejects.toThrow("SANDBOX_TIMEOUT");
  });
  it("quarantines uncertain remote execution and never releases its lease", async () => {
    const { runtime, path, box, config } = await setup();
    const handle = await runtime.prepareDataset("test", path);
    const original = box.runCommand.getMockImplementation()!;
    box.runCommand.mockImplementation(async (cmd, args, opts) => {
      if (args[2].includes("subprocess.Popen")) throw new Error("secret transport detail");
      return original(cmd, args, opts);
    });
    await expect(runtime.execute(handle, "while True: pass")).rejects.toThrow("SHARED_EXECUTION_FAILED");
    await expect(runtime.destroy(handle)).rejects.toThrow("SHARED_RECONCILIATION_REQUIRED");
    await expect(new SingleSandboxRuntime(config).prepareDataset("test", path)).rejects.toThrow("SHARED_SANDBOX_BUSY");
  });
  it("withholds successful output and sanitizes cleanup transport errors", async () => {
    vi.resetModules();
    const { SingleSandboxRuntime: FreshRuntime } = await import("./single");
    const { path, box, config } = await setup();
    const runtime = new FreshRuntime(config);
    const handle = await runtime.prepareDataset("test", path);
    const original = box.runCommand.getMockImplementation()!;
    box.runCommand.mockImplementation(async (cmd, args, opts) => {
      if (args[2].includes("shutil.rmtree")) throw new Error("private SDK diagnostic");
      return original(cmd, args, opts);
    });
    await expect(runtime.execute(handle, "result = {}")).rejects.toThrow("SHARED_CLEANUP_FAILED");
    await expect(runtime.destroy(handle)).rejects.toThrow("SHARED_RECONCILIATION_REQUIRED");
  });
});
