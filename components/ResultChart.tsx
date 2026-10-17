"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ApprovedResult } from "../contracts/results";

function numericKey(result: ApprovedResult): string | null {
  for (const col of result.columns) {
    if (result.rows.some((r) => typeof r[col] === "number")) return col;
  }
  return null;
}

function labelKey(result: ApprovedResult, valueKey: string): string {
  return result.columns.find((c) => c !== valueKey) ?? result.columns[0];
}

/** Renders only validated ApprovedResult data. Skipped when chartType is "none". */
export function ResultChart({ result }: { result: ApprovedResult }) {
  if (result.chartType === "none") return null;
  const valueKey = numericKey(result);
  if (valueKey === null || result.columns.length < 2) return null;
  const nameKey = labelKey(result, valueKey);
  const data = result.rows.map((row) => ({
    name: String(row[nameKey] ?? ""),
    value: typeof row[valueKey] === "number" ? row[valueKey] : 0,
  }));

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#e3ddd2" />
      <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="#6b655a" />
      <YAxis tick={{ fontSize: 12 }} stroke="#6b655a" />
      <Tooltip />
    </>
  );

  return (
    <div className="chart-wrap" role="img" aria-label={`${result.chartType} chart of ${valueKey} by ${nameKey}`}>
      <ResponsiveContainer width="100%" height={280}>
        {result.chartType === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            {axes}
            <Bar dataKey="value" name={valueKey} fill="#1d5c3f" radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            {axes}
            <Line type="monotone" dataKey="value" name={valueKey} stroke="#1d5c3f" strokeWidth={2} dot={false} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
