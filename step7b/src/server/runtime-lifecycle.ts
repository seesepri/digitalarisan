import { pool } from "@/db";
import { beginDraining, isDraining, runtimeLimits } from "@/server/services/runtime-resilience";

let shutdownStarted = false;
let shutdownPromise: Promise<void> | undefined;

export function runtimeStatus() { return { draining: isDraining(), shutdownStarted }; }

export function installGracefulShutdown() {
  if (process.env.NODE_ENV !== "production" || shutdownStarted) return;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return shutdownPromise;
    shutdownStarted = true;
    beginDraining();
    console.warn(JSON.stringify({ level: "WARN", event: "graceful_shutdown_started", signal, graceMs: runtimeLimits.shutdownGraceMs }));
    shutdownPromise = (async () => {
      const deadline = Date.now() + runtimeLimits.shutdownGraceMs;
      while (Date.now() < deadline) {
        try {
          if ((pool as unknown as { waitingCount?: number }).waitingCount === 0) break;
        } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      try { await pool.end(); } catch (error) { console.error(JSON.stringify({ level: "ERROR", event: "db_pool_shutdown_failed", error: String(error) })); }
      console.warn(JSON.stringify({ level: "INFO", event: "graceful_shutdown_complete" }));
      process.exit(0);
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
