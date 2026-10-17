import type Anthropic from "@anthropic-ai/sdk";
import { expect, vi } from "vitest";
import type { QueryJob } from "../../../contracts/job";
import { POST as checkoutRoute } from "../../../app/api/checkout/route";
import { GET as getJobRoute } from "../../../app/api/jobs/[id]/route";
import { POST as createJobRoute } from "../../../app/api/jobs/route";
import { COFFEE_DATASET } from "../catalog";
import type { FakePayments } from "./fakes";

// Shared by the snapshot/fork and single-sandbox integration suites.
// Generated Python never runs on the host: fake sandboxes call
// simulateAnalysis, which computes in TypeScript what each canned script's
// SQL returns from the uploaded synthetic CSV.

export const REVENUE_BY_CATEGORY = `rows = con.execute(
    "SELECT drink_category, ROUND(SUM(revenue), 2) AS revenue, COUNT(*) AS n "
    "FROM dataset GROUP BY drink_category HAVING COUNT(*) >= 10 ORDER BY revenue DESC"
).fetchall()
result = {
    "columns": ["drink_category", "revenue"],
    "rows": [{"drink_category": r[0], "revenue": r[1]} for r in rows],
    "groupSizes": [r[2] for r in rows],
}`;

// Per store, per day, per hour: groups far below the minimum size.
export const TOO_GRANULAR = `rows = con.execute(
    "SELECT store || ' ' || CAST(sale_date AS VARCHAR) || ' ' || CAST(hour AS VARCHAR) AS slot, SUM(revenue), COUNT(*) "
    "FROM dataset GROUP BY 1"
).fetchall()
result = {"columns": ["slot", "revenue"], "rows": [{"slot": r[0], "revenue": r[1]} for r in rows], "groupSizes": [r[2] for r in rows]}`;

// Passes the static checks but reports no group sizes in `result`.
export const NO_GROUP_SIZES = `rows = con.execute("SELECT drink_category, SUM(revenue), COUNT(*) FROM dataset GROUP BY 1").fetchall()
result = {"columns": ["drink_category", "revenue"], "rows": [{"drink_category": r[0], "revenue": r[1]} for r in rows]}
groupSizes = None`;

function parseCsv(text: string): Array<Record<string, string>> {
  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/^"|"$/g, ""));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

/** Stand-in for the SQL each canned script runs, evaluated in the fake VM. */
export function simulateAnalysis(code: string, csv: string): string {
  const records = parseCsv(csv);
  const group = (key: (r: Record<string, string>) => string) => {
    const groups = new Map<string, { revenue: number; n: number }>();
    for (const r of records) {
      const g = groups.get(key(r)) ?? { revenue: 0, n: 0 };
      g.revenue += Number(r.revenue);
      g.n += 1;
      groups.set(key(r), g);
    }
    return [...groups.entries()];
  };
  if (code === REVENUE_BY_CATEGORY) {
    const rows = group((r) => r.drink_category).sort((a, b) => b[1].revenue - a[1].revenue);
    return JSON.stringify({
      columns: ["drink_category", "revenue"],
      rows: rows.map(([k, v]) => ({ drink_category: k, revenue: Math.round(v.revenue * 100) / 100 })),
      groupSizes: rows.map(([, v]) => v.n),
    });
  }
  if (code === TOO_GRANULAR) {
    const rows = group((r) => `${r.store} ${r.sale_date} ${r.hour}`).slice(0, 150);
    return JSON.stringify({
      columns: ["slot", "revenue"],
      rows: rows.map(([k, v]) => ({ slot: k, revenue: v.revenue })),
      groupSizes: rows.map(([, v]) => v.n),
    });
  }
  if (code === NO_GROUP_SIZES) {
    const rows = group((r) => r.drink_category);
    return JSON.stringify({
      columns: ["drink_category", "revenue"],
      rows: rows.map(([k, v]) => ({ drink_category: k, revenue: v.revenue })),
    });
  }
  throw new Error("unexpected analysis code");
}

export function claudeReturning(code: string) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(params);
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_analysis",
              input: { code, summary: "Revenue by drink category.", chartType: "bar" },
            },
          ],
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

export const json = (body: unknown) =>
  new Request("http://test/api", { method: "POST", body: JSON.stringify(body) });

export async function getJob(id: string): Promise<QueryJob> {
  const res = await getJobRoute(new Request(`http://test/api/jobs/${id}`), { params: Promise.resolve({ id }) });
  return res.json();
}

export async function submitAndPay(question: string, payments: FakePayments, pay = true) {
  const created = await createJobRoute(json({ datasetId: COFFEE_DATASET.id, question }));
  expect(created.status).toBe(201);
  const job = (await created.json()) as QueryJob;
  const checkout = await checkoutRoute(json({ jobId: job.id }));
  expect(checkout.status).toBe(200);
  payments.paid = pay;
  return job;
}

export async function waitForTerminal(id: string): Promise<QueryJob> {
  let job!: QueryJob;
  await vi.waitFor(
    async () => {
      job = await getJob(id);
      expect(["completed", "rejected", "execution_failed"]).toContain(job.status);
    },
    { timeout: 3000, interval: 20 }
  );
  return job;
}
