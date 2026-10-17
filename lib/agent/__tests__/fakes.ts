import type {
  CheckoutRequest,
  PaymentProvider,
  PaymentVerification,
} from "../../../contracts/payments";
import type { ExecutionResult, OutputPolicy, ValidationDecision } from "../../../contracts/results";
import type { SandboxRuntime } from "../../../contracts/sandbox";
import type { CodeGenerator, GeneratedAnalysis, GenerationRequest } from "../codegen";
import { StaticDatasetCatalog, type DatasetDescriptor } from "../datasets";
import { InMemoryJobStore } from "../jobStore";
import type { AgentDeps, AgentEvent } from "../orchestrator";

export const dataset: DatasetDescriptor = {
  id: "retail",
  name: "Retail orders",
  description: "Orders from a mid-size retailer",
  path: "/data/retail.parquet",
  tableName: "orders",
  columns: [
    { name: "region", type: "VARCHAR" },
    { name: "amount", type: "DOUBLE" },
    { name: "customer_email", type: "VARCHAR" },
  ],
  priceCents: 500,
};

export const safeCode = `import duckdb, json
rows = con.execute("SELECT region, COUNT(*) AS n, AVG(amount) AS avg FROM orders GROUP BY region HAVING COUNT(*) >= 10").fetchall()
print(json.dumps({"columns": ["region", "n", "avg"], "rows": [dict(region=r[0], n=r[1], avg=r[2]) for r in rows], "groupSizes": [r[1] for r in rows]}))`;

export const execution: ExecutionResult = {
  columns: ["region", "n", "avg"],
  rows: [
    { region: "EU", n: 40, avg: 12.5 },
    { region: "US", n: 60, avg: 20 },
  ],
  groupSizes: [40, 60],
};

export class FakePayments implements PaymentProvider {
  paid = true;
  sessions = new Map<string, string>();
  verifyCalls = 0;

  async createCheckout(request: CheckoutRequest) {
    const sessionId = `cs_${request.jobId}`;
    this.sessions.set(sessionId, request.jobId);
    return { sessionId, checkoutUrl: `https://checkout.test/${sessionId}` };
  }

  async verifyPayment(sessionId: string): Promise<PaymentVerification> {
    this.verifyCalls++;
    return { jobId: this.sessions.get(sessionId) ?? "", paid: this.paid, stripeSessionId: sessionId };
  }
}

export class FakeSandbox implements SandboxRuntime {
  executeImpl: (code: string) => Promise<ExecutionResult> = async () => execution;
  prepared: string[] = [];
  destroyed: string[] = [];
  executed: string[] = [];

  async prepareDataset(datasetId: string) {
    const id = `snap_${datasetId}_${this.prepared.length}`;
    this.prepared.push(id);
    return id;
  }

  async execute(_snapshotId: string, code: string) {
    this.executed.push(code);
    return this.executeImpl(code);
  }

  async destroy(snapshotId: string) {
    this.destroyed.push(snapshotId);
  }
}

export class FakePolicy implements OutputPolicy {
  decisions: ValidationDecision[] = [];

  async validate(result: ExecutionResult): Promise<ValidationDecision> {
    return (
      this.decisions.shift() ?? {
        approved: true,
        result: { summary: "policy", columns: result.columns, rows: result.rows, chartType: "none" },
      }
    );
  }
}

export class FakeCodegen implements CodeGenerator {
  queue: Array<GeneratedAnalysis | Error> = [];
  requests: GenerationRequest[] = [];

  async generate(request: GenerationRequest) {
    this.requests.push(structuredClone(request));
    const next = this.queue.shift() ?? {
      code: safeCode,
      summary: "Average order value by region.",
      chartType: "bar" as const,
    };
    if (next instanceof Error) throw next;
    return next;
  }
}

export function makeDeps() {
  const events: AgentEvent[] = [];
  const deps = {
    store: new InMemoryJobStore(),
    datasets: new StaticDatasetCatalog([dataset]),
    payments: new FakePayments(),
    sandbox: new FakeSandbox(),
    policy: new FakePolicy(),
    codegen: new FakeCodegen(),
    options: { timeoutMs: 1000, maxRetries: 2 },
    onEvent: (e: AgentEvent) => events.push(e),
  } satisfies AgentDeps;
  return { deps, events };
}
