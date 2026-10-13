import assert from "node:assert/strict";
import test from "node:test";
import { recordRequest, prometheusText } from "@/server/metrics";

test("arbitrary API paths cannot grow telemetry label cardinality without bound", () => {
  for (let n = 0; n < 6000; n++) recordRequest("GET", `/api/v1/nonexistent-${n.toString(36)}-unique`);
  const text = prometheusText(); const series = text.split("\n").filter((line) => line.startsWith("digital_arisan_http_requests_total{"));
  assert.ok(series.length <= 2000); assert.match(text, /digital_arisan_telemetry_series_dropped_total\{\} [1-9]/);
});
