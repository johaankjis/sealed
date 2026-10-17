/** Local MVP catalog types. There is no shared Dataset contract yet
 *  (see INTEGRATION.md); these fixtures let the marketplace render
 *  before a catalog backend exists. */

export interface DatasetListing {
  id: string;
  name: string;
  owner: string;
  description: string;
  rowCount: string;
  priceCents: number;
  sampleQuestions: string[];
  updatedAt: string;
}

export const DEMO_DATASETS: DatasetListing[] = [
  {
    id: "downtown-coffee-sales",
    name: "Downtown Coffee Sales",
    owner: "Harbor Roasters Collective",
    description:
      "Two years of anonymized point-of-sale transactions across 14 downtown coffee shops: daily revenue, drink categories, and rush-hour patterns.",
    rowCount: "~310k transactions",
    priceCents: 900,
    sampleQuestions: [
      "What are the top 5 drink categories by revenue each quarter?",
      "Which weekday has the highest morning rush revenue?",
      "How did oat-milk drink sales trend month over month?",
    ],
    updatedAt: "2026-09-30",
  },
  {
    id: "bike-share-trips",
    name: "City Bike-Share Trips",
    owner: "Metro Mobility Data Trust",
    description:
      "Aggregated station-to-station trip counts, trip durations, and membership mix for a city bike-share network. No individual rider records.",
    rowCount: "~1.2M trips",
    priceCents: 1200,
    sampleQuestions: [
      "What are the busiest origin stations by month?",
      "How does average trip duration vary by membership type?",
      "Which station pairs grew the most year over year?",
    ],
    updatedAt: "2026-10-01",
  },
  {
    id: "farmers-market-vendors",
    name: "Farmers Market Vendors",
    owner: "Greenbelt Growers Alliance",
    description:
      "Weekly stall revenue, foot traffic estimates, and produce category mix from 22 seasonal markets. Vendor identities are withheld.",
    rowCount: "~48k market-days",
    priceCents: 600,
    sampleQuestions: [
      "Which produce categories earn the most per market-day?",
      "How does foot traffic correlate with weekend vs weekday markets?",
      "What is the seasonal revenue curve for berry vendors?",
    ],
    updatedAt: "2026-08-15",
  },
];

export function getDemoDataset(id: string): DatasetListing | undefined {
  return DEMO_DATASETS.find((d) => d.id === id);
}

export function formatPrice(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(priceCents % 100 === 0 ? 0 : 2)}`;
}
