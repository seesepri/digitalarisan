#!/usr/bin/env bash
set -euo pipefail
# Production may use Docker/Kubernetes secret files. Never commit their values.
for name in AUTH_SECRET CRON_SECRET METRICS_TOKEN MIDTRANS_SERVER_KEY PAYOUT_PROVIDER_API_KEY DATABASE_URL BANK_PII_ENCRYPTION_KEY; do
  if [ -n "${!name:-}" ]; then
    value="${!name}"
    if [[ "$value" == *replace-with* || "$value" == *your-* || "$value" == *password* ]]; then
      echo "ERROR: $name looks like a placeholder" >&2; exit 1
    fi
  elif [ -f "/run/secrets/${name,,}" ]; then
    test -s "/run/secrets/${name,,}" || { echo "ERROR: empty secret file $name" >&2; exit 1; }
  else
    echo "ERROR: missing production secret $name" >&2; exit 1
  fi
done

# Financial PII encryption is a production-critical cryptographic secret.
if [ "${NODE_ENV:-production}" = production ]; then
  pii_key="${BANK_PII_ENCRYPTION_KEY:-}"
  if [ -z "$pii_key" ] && [ -f /run/secrets/bank_pii_encryption_key ]; then
    pii_key="$(cat /run/secrets/bank_pii_encryption_key)"
  fi
  if [ -z "$pii_key" ]; then
    echo 'ERROR: BANK_PII_ENCRYPTION_KEY is required in production' >&2
    exit 1
  fi
  if ! printf '%s' "$pii_key" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ try { const b=Buffer.from(s.trim(),"base64"); process.exit(b.length===32 && b.toString("base64").replace(/=+$/g,"")===s.trim().replace(/=+$/g,"") ? 0 : 1); } catch { process.exit(1); } })'; then
    echo 'ERROR: BANK_PII_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes' >&2
    exit 1
  fi
fi

if [ "${NODE_ENV:-production}" = production ] && [ -n "${AUTH_SECRET:-}" ] && [ "${#AUTH_SECRET}" -lt 32 ]; then
  echo 'ERROR: AUTH_SECRET must be at least 32 characters' >&2
  exit 1
fi

if [ "${NODE_ENV:-production}" = production ] && [ "${TRUST_PROXY:-false}" != true ]; then
  echo 'ERROR: TRUST_PROXY=true is required behind the hardened reverse proxy' >&2; exit 1
fi
echo 'Production secret checks PASS.'
