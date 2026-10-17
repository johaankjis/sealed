import type { ApprovedResult } from "../contracts/results";
import type { QueryJob } from "../contracts/job";

/** Clearly-labeled preview fixtures so the result UI is demonstrable
 *  before the backend agents land their routes. Not real data. */
export const DEMO_RESULT: ApprovedResult = {
  summary:
    "Espresso drinks earned the most revenue in every quarter, growing 18% year over year, while cold brew showed the fastest growth at 34%.",
  columns: ["category", "q3_revenue", "q4_revenue"],
  rows: [
    { category: "Espresso", q3_revenue: 48210, q4_revenue: 55430 },
    { category: "Cold brew", q3_revenue: 18940, q4_revenue: 25380 },
    { category: "Drip", q3_revenue: 22100, q4_revenue: 21760 },
    { category: "Tea", q3_revenue: 9840, q4_revenue: 11205 },
    { category: "Pastries", q3_revenue: 15230, q4_revenue: 16890 },
  ],
  chartType: "bar",
};

export const DEMO_JOB: QueryJob = {
  id: "demo",
  datasetId: "downtown-coffee-sales",
  question: "What are the top drink categories by revenue each quarter?",
  status: "completed",
  result: DEMO_RESULT,
};
