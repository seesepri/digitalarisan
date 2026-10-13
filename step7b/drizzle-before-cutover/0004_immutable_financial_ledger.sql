-- v4: Immutable financial ledger
-- wallet_transactions and financial_transactions are append-only.
-- Corrections must be represented by a new reversal/adjustment transaction.

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid REFERENCES wallet_transactions(id) ON DELETE RESTRICT;

ALTER TABLE financial_transactions
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid REFERENCES financial_transactions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS wallet_transactions_reversal_of_idx
  ON wallet_transactions(reversal_of_id);

CREATE INDEX IF NOT EXISTS financial_transactions_reversal_of_idx
  ON financial_transactions(reversal_of_id);

CREATE OR REPLACE FUNCTION prevent_immutable_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_LEDGER: % rows cannot be updated or deleted from %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS wallet_transactions_immutable_trg ON wallet_transactions;
CREATE TRIGGER wallet_transactions_immutable_trg
BEFORE UPDATE OR DELETE ON wallet_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_immutable_ledger_mutation();

DROP TRIGGER IF EXISTS financial_transactions_immutable_trg ON financial_transactions;
CREATE TRIGGER financial_transactions_immutable_trg
BEFORE UPDATE OR DELETE ON financial_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_immutable_ledger_mutation();

-- Existing financial facts are retained. No backfill or mutation is performed.
-- A correction references the original row using reversal_of_id.
