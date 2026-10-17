// Synthetic "Downtown Coffee Sales" dataset for the demo. Fully generated from
// a fixed seed: no real customers, stores, or transactions. Regenerate with
//   node lib/agent/demo/coffee.ts

export const COFFEE_COLUMNS = [
  { name: "sale_date", type: "DATE", description: "Calendar date, 2024-10-01 to 2026-09-30" },
  { name: "month", type: "VARCHAR", description: "YYYY-MM" },
  { name: "quarter", type: "VARCHAR", description: "e.g. 2025-Q3" },
  { name: "weekday", type: "VARCHAR", description: "Monday..Sunday" },
  { name: "hour", type: "INTEGER", description: "Hour of sale, 6-19" },
  { name: "daypart", type: "VARCHAR", description: "morning_rush, midday, afternoon" },
  { name: "store", type: "VARCHAR", description: "One of 14 downtown shops" },
  { name: "drink_category", type: "VARCHAR", description: "espresso, latte, cold_brew, tea, drip, seasonal, pastry" },
  { name: "milk_type", type: "VARCHAR", description: "none, dairy, oat, almond" },
  { name: "size", type: "VARCHAR", description: "small, medium, large" },
  { name: "quantity", type: "INTEGER", description: "Items in the line" },
  { name: "revenue", type: "DOUBLE", description: "Line revenue in USD" },
  { name: "loyalty_member", type: "BOOLEAN", description: "Whether the buyer used a loyalty card" },
];

const STORES = [
  "Harbor & 1st", "Pike Arcade", "Union Square", "Civic Center", "Pioneer Plaza",
  "Market Hall", "Ferry Terminal", "Library Row", "Court Street", "Gallery Walk",
  "Station East", "Riverside", "Old Mill", "Tech Commons",
];

const CATEGORIES: Array<{ name: string; weight: number; price: number; milk: boolean }> = [
  { name: "latte", weight: 28, price: 5.25, milk: true },
  { name: "espresso", weight: 12, price: 3.5, milk: false },
  { name: "cold_brew", weight: 16, price: 4.75, milk: true },
  { name: "drip", weight: 18, price: 2.95, milk: false },
  { name: "tea", weight: 9, price: 3.75, milk: true },
  { name: "seasonal", weight: 7, price: 6.25, milk: true },
  { name: "pastry", weight: 10, price: 3.95, milk: false },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SIZE_MULT = { small: 0.85, medium: 1, large: 1.2 } as const;

// mulberry32: small deterministic PRNG.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends { weight: number }>(items: T[], r: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let x = r * total;
  for (const item of items) {
    if ((x -= item.weight) < 0) return item;
  }
  return items[items.length - 1];
}

export function generateCoffeeCsv(rowsPerDay = 30, seed = 42): string {
  const rand = rng(seed);
  const lines = [COFFEE_COLUMNS.map((c) => c.name).join(",")];
  const start = Date.UTC(2024, 9, 1);
  const end = Date.UTC(2026, 8, 30);

  for (let day = start; day <= end; day += 86_400_000) {
    const d = new Date(day);
    const iso = d.toISOString().slice(0, 10);
    const month = iso.slice(0, 7);
    const quarter = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    const weekday = WEEKDAYS[d.getUTCDay()];
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    // Months since start, for the oat-milk growth trend.
    const monthIndex = (d.getUTCFullYear() - 2024) * 12 + d.getUTCMonth() - 9;
    const seasonal = d.getUTCMonth() >= 8 && d.getUTCMonth() <= 11;
    const count = Math.round(rowsPerDay * (weekend ? 0.7 : 1) * (0.85 + rand() * 0.3));

    for (let i = 0; i < count; i++) {
      // Weekday mornings are busiest.
      const hour = rand() < (weekend ? 0.3 : 0.5) ? 6 + Math.floor(rand() * 4) : 10 + Math.floor(rand() * 10);
      const daypart = hour < 10 ? "morning_rush" : hour < 14 ? "midday" : "afternoon";
      const category = pickWeighted(
        CATEGORIES.map((c) => ({ ...c, weight: c.name === "seasonal" && seasonal ? c.weight * 3 : c.weight })),
        rand()
      );
      const oatShare = 0.15 + monthIndex * 0.012;
      const m = rand();
      const milk = !category.milk ? "none" : m < oatShare ? "oat" : m < oatShare + 0.1 ? "almond" : "dairy";
      const size = category.name === "pastry" ? "medium" : (["small", "medium", "large"] as const)[Math.floor(rand() * 3)];
      const quantity = rand() < 0.85 ? 1 : 2;
      const altMilk = milk === "oat" || milk === "almond" ? 0.7 : 0;
      const revenue = (category.price * SIZE_MULT[size] + altMilk) * quantity;
      const store = STORES[Math.floor(rand() * STORES.length)];
      lines.push(
        [iso, month, quarter, weekday, hour, daypart, `"${store}"`, category.name, milk, size, quantity,
          revenue.toFixed(2), rand() < 0.35].join(",")
      );
    }
  }
  return lines.join("\n") + "\n";
}

// CLI entry: writes lib/agent/fixtures/downtown-coffee-sales.csv.
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = process.getBuiltinModule("node:fs");
  const target = new URL("../fixtures/downtown-coffee-sales.csv", import.meta.url);
  const csv = generateCoffeeCsv();
  writeFileSync(target, csv);
  console.log(`wrote ${csv.split("\n").length - 2} rows to ${target.pathname}`);
}
