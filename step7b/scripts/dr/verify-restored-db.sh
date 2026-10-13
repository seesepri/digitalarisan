#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
select current_database(), current_user, now();
select count(*) as users_count from users;
select count(*) as wallets_count from wallets;
select count(*) as wallet_transactions_count from wallet_transactions;
select count(*) as financial_transactions_count from financial_transactions;
select count(*) as reconciliation_runs_count from reconciliation_runs;

-- Financial safety smoke checks. A restored database must not contain negative balances.
select count(*) as negative_wallet_balances
from wallets
where available_balance < 0 or locked_balance < 0 or pending_balance < 0;

select count(*) as negative_financial_accounts
from financial_accounts
where balance < 0;
SQL

NEGATIVE_WALLETS="$(psql "$DATABASE_URL" -Atqc 'select count(*) from wallets where available_balance < 0 or locked_balance < 0 or pending_balance < 0')"
NEGATIVE_ACCOUNTS="$(psql "$DATABASE_URL" -Atqc 'select count(*) from financial_accounts where balance < 0')"
[[ "$NEGATIVE_WALLETS" == "0" ]] || { echo "DR verification failed: negative wallet balance(s)" >&2; exit 1; }
[[ "$NEGATIVE_ACCOUNTS" == "0" ]] || { echo "DR verification failed: negative financial account balance(s)" >&2; exit 1; }
printf '%s\n' "Restored database safety smoke checks passed."
