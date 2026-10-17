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

/**
 * Reviewed SHA256 digests of synthetic fixtures. Single-sandbox mode refuses
 * any file not listed here. Update only after reviewing a regenerated fixture
 * (catalog.test.ts checks the digest against the file).
 */
export const SYNTHETIC_DATASET_REGISTRY: Record<string, { sha256: string; tableName: string }> = {
  [COFFEE_DATASET.id]: {
    sha256: "6858719376834cb295e5519e569a81770352a9dc7433b0642cd694be349e7f25",
    tableName: COFFEE_DATASET.tableName,
  },
};
