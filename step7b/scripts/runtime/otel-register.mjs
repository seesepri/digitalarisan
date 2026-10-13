let sdk;
if (process.env.OTEL_ENABLED !== "false" && process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "");
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: process.env.OTEL_SERVICE_NAME || "digital-arisan-worker",
  });
  await sdk.start();
  const shutdown = () => sdk?.shutdown().catch(() => undefined);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
