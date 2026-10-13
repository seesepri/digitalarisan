let telemetryStarted = false;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installGracefulShutdown } = await import("@/server/runtime-lifecycle");
    installGracefulShutdown();
    if (process.env.OTEL_ENABLED !== "false" && !telemetryStarted) {
      telemetryStarted = true;
      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
      const { HttpInstrumentation } = await import(
      "@opentelemetry/instrumentation-http");
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
      if (endpoint) {
        const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` });
        const sdk = new NodeSDK({
        traceExporter: exporter,
        instrumentations: [
        new HttpInstrumentation(),],
  serviceName: process.env.OTEL_SERVICE_NAME || "digital-arisan",
});
        await sdk.start();
        process.once("SIGTERM", () => { void sdk.shutdown(); });
      }
    }
  }
}
