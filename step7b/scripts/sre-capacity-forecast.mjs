#!/usr/bin/env node
import fs from "node:fs";
const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/sre-capacity-forecast.mjs <csv>");
const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(1).map(line => line.split(",").map(Number)).filter(r => r.length >= 3 && r.every(Number.isFinite));
if (rows.length < 3) throw new Error("at least 3 observations required");
function regression(index) { const xs=rows.map((_,i)=>i); const ys=rows.map(r=>r[index]); const mx=xs.reduce((a,b)=>a+b,0)/xs.length; const my=ys.reduce((a,b)=>a+b,0)/ys.length; const slope=xs.reduce((s,x,i)=>s+(x-mx)*(ys[i]-my),0)/xs.reduce((s,x)=>s+(x-mx)**2,0); return { current: ys.at(-1), slopePerObservation: slope, forecast: ys.at(-1)+slope*Number(process.env.FORECAST_HORIZON || 12) }; }
const rps = regression(1); const p95 = regression(2);
console.log(JSON.stringify({ observations: rows.length, horizon: Number(process.env.FORECAST_HORIZON || 12), rps, p95Ms: p95, recommendation: p95.forecast > Number(process.env.CAPACITY_P95_LIMIT_MS || 750) ? "scale_or_optimize" : "within_latency_budget" }, null, 2));
