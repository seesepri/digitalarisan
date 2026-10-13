# Enterprise Observability

The application is Docker-independent. Production observability should run as a separate approved service/process or managed platform component:

`web/worker -> OTLP -> collector/managed tracing backend`

The application uses `OTEL_EXPORTER_OTLP_ENDPOINT` for the tracing destination. Set it to the organization's approved collector or managed backend endpoint; do not embed backend credentials in source or build artifacts.

Keep `/api/metrics` behind the existing metrics authentication and scrape it from the monitoring network. `/api/slo` requires `SRE_TOKEN` (or `METRICS_TOKEN`).
