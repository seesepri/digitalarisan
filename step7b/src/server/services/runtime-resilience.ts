import { log } from "@/server/services/observability";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
type Circuit = { state: CircuitState; failures: number; openedAt: number; probeInFlight: boolean };

const circuits = new Map<string, Circuit>();
let activeProviderCalls = 0;
const waiters: Array<() => void> = [];

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
};

export const runtimeLimits = {
  providerTimeoutMs: envInt("PROVIDER_TIMEOUT_MS", 15_000, 250, 120_000),
  providerMaxConcurrency: envInt("PROVIDER_MAX_CONCURRENCY", 32, 1, 500),
  providerMaxQueue: envInt("PROVIDER_MAX_QUEUE", 128, 0, 5000),
  circuitFailureThreshold: envInt("PROVIDER_CIRCUIT_FAILURE_THRESHOLD", 5, 1, 100),
  circuitOpenMs: envInt("PROVIDER_CIRCUIT_OPEN_MS", 30_000, 1_000, 600_000),
  shutdownGraceMs: envInt("SHUTDOWN_GRACE_MS", 30_000, 5_000, 300_000),
};

function circuitFor(key: string): Circuit {
  const existing = circuits.get(key);
  if (existing) return existing;
  const created: Circuit = { state: "CLOSED", failures: 0, openedAt: 0, probeInFlight: false };
  circuits.set(key, created);
  return created;
}

async function acquireProviderSlot(): Promise<void> {
  if (activeProviderCalls < runtimeLimits.providerMaxConcurrency) {
    activeProviderCalls += 1;
    return;
  }
  if (waiters.length >= runtimeLimits.providerMaxQueue) { const error = new Error("Provider sedang terlalu sibuk; permintaan ditolak untuk menjaga backpressure."); Object.assign(error, { code: "PROVIDER_BACKPRESSURE", status: 503 }); throw error; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeProviderCalls += 1;
}

function releaseProviderSlot() {
  activeProviderCalls = Math.max(0, activeProviderCalls - 1);
  const next = waiters.shift();
  if (next) next();
}

function beforeCall(key: string): () => void {
  const circuit = circuitFor(key);
  if (circuit.state === "OPEN") {
    if (Date.now() - circuit.openedAt < runtimeLimits.circuitOpenMs) { const error = new Error("Provider sementara dihentikan oleh circuit breaker."); Object.assign(error, { code: "PROVIDER_CIRCUIT_OPEN", status: 503 }); throw error; }
    if (circuit.probeInFlight) { const error = new Error("Provider sedang menjalani health probe."); Object.assign(error, { code: "PROVIDER_CIRCUIT_OPEN", status: 503 }); throw error; }
    circuit.state = "HALF_OPEN";
    circuit.probeInFlight = true;
  }
  return () => { if (circuit.state === "HALF_OPEN") circuit.probeInFlight = false; };
}

function success(key: string) {
  const circuit = circuitFor(key);
  circuit.failures = 0;
  circuit.state = "CLOSED";
  circuit.probeInFlight = false;
}

function failure(key: string, error: unknown) {
  const circuit = circuitFor(key);
  circuit.probeInFlight = false;
  circuit.failures += 1;
  if (circuit.failures >= runtimeLimits.circuitFailureThreshold) {
    circuit.state = "OPEN";
    circuit.openedAt = Date.now();
    log("ERROR", "provider_circuit_opened", { provider: key, failures: circuit.failures, error });
  }
}

export async function providerFetch(provider: string, operation: string, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const key = `${provider}:${operation}`;
  const releaseProbe = beforeCall(key);
  let acquired = false;
  try {
    await acquireProviderSlot();
    acquired = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runtimeLimits.providerTimeoutMs);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.status >= 500 || response.status === 429) failure(key, new Error(`HTTP_${response.status}`));
      else success(key);
      return response;
    } catch (error) {
      failure(key, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    releaseProbe();
    if (acquired) releaseProviderSlot();
  }
}

export function providerCircuitSnapshot() {
  return Array.from(circuits.entries()).map(([key, value]) => ({ key, state: value.state, failures: value.failures, openedAt: value.openedAt }));
}

let draining = false;
export function isDraining() { return draining; }
export function beginDraining() { draining = true; }
