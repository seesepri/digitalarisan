#!/usr/bin/env node
import { createHmac } from "node:crypto";
const webhook = process.env.INCIDENT_WEBHOOK_URL;
if (!webhook) throw new Error("INCIDENT_WEBHOOK_URL is required");
const secret = process.env.INCIDENT_WEBHOOK_SECRET || "";
const body = process.argv[2] || await new Promise((resolve) => { let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => resolve(s)); });
const payload = body.trim();
if (!payload) throw new Error("incident payload is required");
const signature = secret ? createHmac("sha256", secret).update(payload).digest("hex") : "";
const response = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "X-Incident-Signature": signature } : {}) }, body: payload, signal: AbortSignal.timeout(Number(process.env.INCIDENT_WEBHOOK_TIMEOUT_MS || 5000)) });
if (!response.ok) throw new Error(`incident webhook failed: HTTP ${response.status}`);
console.log(JSON.stringify({ dispatched: true, timestamp: new Date().toISOString() }));
