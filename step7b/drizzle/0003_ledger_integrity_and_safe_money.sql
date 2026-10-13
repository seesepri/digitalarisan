-- Sequence allocation at INSERT, under wallet/account locks, orders new ledger entries causally.
-- Values assigned to pre-existing rows are NOT proof of historical causal order. Reconcile the restored
-- staging history before adoption; do not silently reorder/rewrite legacy immutable financial records.
ALTER TABLE wallet_transactions ADD COLUMN ledger_sequence bigint GENERATED ALWAYS AS IDENTITY;
--> statement-breakpoint
ALTER TABLE financial_transactions ADD COLUMN ledger_sequence bigint GENERATED ALWAYS AS IDENTITY;
--> statement-breakpoint
CREATE UNIQUE INDEX wallet_transactions_ledger_sequence_unique ON wallet_transactions (ledger_sequence);
--> statement-breakpoint
CREATE INDEX wallet_transactions_wallet_sequence_idx ON wallet_transactions (wallet_id, ledger_sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX financial_transactions_ledger_sequence_unique ON financial_transactions (ledger_sequence);
--> statement-breakpoint
CREATE INDEX financial_transactions_account_sequence_idx ON financial_transactions (account_id, ledger_sequence);
--> statement-breakpoint
-- Existing duplicate corrections must block migration, never be deleted to make this gate pass.
CREATE UNIQUE INDEX wallet_transactions_reversal_unique ON wallet_transactions (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX financial_transactions_reversal_unique ON financial_transactions (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
--> statement-breakpoint
-- Every BIGINT money column must fit the application's exact JavaScript integer range.
DO $$ DECLARE item record; predicate text; BEGIN
  FOR item IN SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public'
    AND data_type = 'bigint' AND column_name NOT IN ('sequence_no', 'ledger_sequence') LOOP
    SELECT string_agg(format('%I BETWEEN 0 AND 9007199254740991', column_name), ' AND ' ORDER BY column_name)
      INTO predicate FROM information_schema.columns WHERE table_schema = 'public' AND table_name = item.table_name
      AND data_type = 'bigint' AND column_name NOT IN ('sequence_no', 'ledger_sequence');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', item.table_name, item.table_name || '_safe_money_range', predicate);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE wallets ADD CONSTRAINT wallets_total_safe_money CHECK (available_balance + locked_balance + pending_balance <= 9007199254740991) NOT VALID;
--> statement-breakpoint
-- Prevent cross-owner records even if a future service accidentally combines unrelated IDs.
CREATE UNIQUE INDEX wallets_id_user_unique ON wallets (id, user_id);
--> statement-breakpoint
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_wallet_owner_fk FOREIGN KEY (wallet_id, user_id) REFERENCES wallets (id, user_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_wallet_owner_fk FOREIGN KEY (wallet_id, user_id) REFERENCES wallets (id, user_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE topups ADD CONSTRAINT topups_wallet_owner_fk FOREIGN KEY (wallet_id, user_id) REFERENCES wallets (id, user_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE wallet_reservations ADD CONSTRAINT wallet_reservations_wallet_owner_fk FOREIGN KEY (wallet_id, user_id) REFERENCES wallets (id, user_id) NOT VALID;
--> statement-breakpoint
CREATE UNIQUE INDEX arisan_participants_reservation_identity_unique ON arisan_participants (id, user_id, period_id, contribution_amount);
--> statement-breakpoint
ALTER TABLE wallet_reservations ADD CONSTRAINT wallet_reservations_participant_identity_fk FOREIGN KEY (participant_id, user_id, period_id, amount) REFERENCES arisan_participants (id, user_id, period_id, contribution_amount) NOT VALID;
--> statement-breakpoint
-- The old default allocated a sequence BEFORE the advisory lock: waiters could commit a reversed hash chain.
-- Allocate again INSIDE the serialization lock. Gaps are intentional; monotonic order is what matters.
CREATE OR REPLACE FUNCTION audit_logs_set_integrity_hash() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public SET timezone = 'UTC' AS $$
DECLARE previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(84721931);
  NEW.sequence_no := nextval(pg_get_serial_sequence('public.audit_logs', 'sequence_no'));
  SELECT entry_hash INTO previous FROM public.audit_logs ORDER BY sequence_no DESC LIMIT 1;
  NEW.prev_hash := previous;
  NEW.entry_hash := encode(public.digest(
    coalesce(NEW.prev_hash, '') || '|' || NEW.id::text || '|' || coalesce(NEW.actor_id::text, '') || '|' || NEW.actor_type || '|' || NEW.action || '|' ||
    NEW.entity_type || '|' || coalesce(NEW.entity_id::text, '') || '|' || coalesce(NEW.old_value::text, '') || '|' || coalesce(NEW.new_value::text, '') || '|' ||
    coalesce(NEW.ip_address, '') || '|' || coalesce(NEW.user_agent, '') || '|' || NEW.created_at::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;
