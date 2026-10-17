import { expect, it } from "vitest";
import { createClient } from "@nodeops-createos/sandbox";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SingleSandboxRuntime, SHARED_SANDBOX_ID } from "./single";

it.skipIf(process.env.SEALED_SINGLE_LIVE !== "1")("existing credited sandbox: synthetic aggregate, timeout, cleanup", async () => {
  const auth = JSON.parse(await readFile(`${homedir()}/.createos/.oauth`, "utf8"));
  const client = createClient({ authHeaders: { "X-Access-Token": auth.access_token }, retry: false });
  const dir = await mkdtemp(`${tmpdir()}/sealed-shared-smoke-`);
  const csv = "value\n1\n2\n";
  await writeFile(`${dir}/synthetic.csv`, csv);
  const runtime = new SingleSandboxRuntime({ client, timeoutMs: 1000,
    syntheticDatasets: { smoke: { sha256: createHash("sha256").update(csv).digest("hex"), tableName: "dataset" } },
    authorizeExecution: async () => true, // Synthetic smoke only; never production payment wiring.
  });
  let handle: string | undefined;
  try {
    handle = await runtime.prepareDataset("smoke", `${dir}/synthetic.csv`);
    expect(await runtime.execute(handle, 'result = {"columns":["total"],"rows":[{"total":con.execute("SELECT SUM(value) FROM dataset").fetchone()[0]}],"groupSizes":[2]}'))
      .toEqual({ columns: ["total"], rows: [{ total: 3 }], groupSizes: [2] });
    await runtime.destroy(handle);
    handle = await runtime.prepareDataset("smoke", `${dir}/synthetic.csv`);
    await expect(runtime.execute(handle, "while True: pass")).rejects.toThrow("SANDBOX_TIMEOUT");
    await runtime.destroy(handle);
    const box = await client.getSandbox(SHARED_SANDBOX_ID);
    expect(box.data.status).toBe("running");
    const check = await box.runCommand("python3", ["-I", "-c", "import glob; assert not glob.glob('/tmp/sealed-shared-*'); assert not glob.glob('/tmp/sealed-shared.lock'); print('CLEAN')"], { timeoutMs: 10000, retry: false });
    expect(check.result.stdout.trim()).toBe("CLEAN");
    expect(check.result.exit_code).toBe(0);
  } finally {
    if (handle) await runtime.destroy(handle);
    await rm(dir, { recursive: true });
  }
}, 120_000);
