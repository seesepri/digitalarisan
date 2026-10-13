-- Deferred checks observe the completed transaction, not temporary bucket movements within it.
CREATE FUNCTION enforce_wallet_reservation_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wallet_key uuid; pending_total bigint; locked_total bigint; actual_pending bigint; actual_locked bigint;
BEGIN
  IF TG_TABLE_NAME = 'wallets' THEN wallet_key := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN wallet_key := OLD.wallet_id;
  ELSE wallet_key := NEW.wallet_id; END IF;
  SELECT pending_balance, locked_balance INTO actual_pending, actual_locked FROM wallets WHERE id = wallet_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO pending_total FROM withdrawals WHERE wallet_id = wallet_key AND status IN ('PENDING', 'PROCESSING', 'FAILED_RETRYABLE');
  SELECT COALESCE(SUM(amount), 0) INTO locked_total FROM wallet_reservations WHERE wallet_id = wallet_key AND status = 'ACTIVE';
  IF actual_pending <> pending_total THEN RAISE EXCEPTION 'WALLET_PENDING_WITHDRAWAL_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF actual_locked <> locked_total THEN RAISE EXCEPTION 'WALLET_LOCKED_RESERVATION_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME <> 'wallets' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.wallet_id IS DISTINCT FROM NEW.wallet_id THEN
        RAISE EXCEPTION 'RESERVATION_WALLET_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallets_reservation_invariants AFTER INSERT OR UPDATE ON wallets
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_wallet_reservation_invariants();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER withdrawals_reservation_invariants AFTER INSERT OR UPDATE OR DELETE ON withdrawals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_wallet_reservation_invariants();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_reservations_invariants AFTER INSERT OR UPDATE OR DELETE ON wallet_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_wallet_reservation_invariants();
