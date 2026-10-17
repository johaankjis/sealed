import { join } from "node:path";
import { COFFEE_COLUMNS } from "./demo/coffee";
import type { DatasetDescriptor } from "./datasets";

// Trusted server-side catalog. IDs match components/datasets.ts so the
// marketplace pages and the backend agree. Only datasets listed here can be
// queried; paths never come from buyer input.

const FIXTURE_DIR = process.env.SEALED_DATA_DIR ?? join(process.cwd(), "lib/agent/fixtures");

export const COFFEE_DATASET: DatasetDescriptor = {
  id: "downtown-coffee-sales",
  name: "Downtown Coffee Sales",
  description:
    "Synthetic point-of-sale lines from 14 downtown coffee shops, Oct 2024 to Sep 2026. " +
    "One row per sale line; no customer identifiers.",
  path: join(FIXTURE_DIR, "downtown-coffee-sales.csv"),
  // Must match sandbox/runner.py, which loads the CSV as `dataset`.
  tableName: "dataset",
  columns: COFFEE_COLUMNS,
  rowCount: 20010,
  priceCents: 900,
};

export const DEMO_CATALOG: DatasetDescriptor[] = [COFFEE_DATASET];
