DO $$ BEGIN
  CREATE TYPE wallet_reservation_status AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS wallet_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES arisan_participants(id) ON DELETE RESTRICT,
  period_id uuid NOT NULL REFERENCES arisan_periods(id) ON DELETE RESTRICT,
  amount bigint NOT NULL,
  status wallet_reservation_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT wallet_reservations_amount_positive CHECK (amount > 0),
  CONSTRAINT wallet_reservations_status_dates CHECK (
    (status = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL) OR
    (status = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_reservations_participant_unique
  ON wallet_reservations(participant_id);
CREATE INDEX IF NOT EXISTS wallet_reservations_wallet_status_idx
  ON wallet_reservations(wallet_id, status);
CREATE INDEX IF NOT EXISTS wallet_reservations_period_status_idx
  ON wallet_reservations(period_id, status);

INSERT INTO wallet_reservations (wallet_id, user_id, participant_id, period_id, amount, status, created_at)
SELECT w.id, p.user_id, p.id, p.period_id, p.contribution_amount, 'ACTIVE', p.locked_at
FROM arisan_participants p
JOIN wallets w ON w.user_id = p.user_id
WHERE p.status = 'ACTIVE'
ON CONFLICT (participant_id) DO NOTHING;

DO $$
DECLARE mismatch_count integer;
BEGIN
  SELECT COUNT(*) INTO mismatch_count
  FROM wallets w
  LEFT JOIN (
    SELECT wallet_id, COALESCE(SUM(amount), 0) AS reserved_amount
    FROM wallet_reservations
    WHERE status = 'ACTIVE'
    GROUP BY wallet_id
  ) r ON r.wallet_id = w.id
  WHERE w.locked_balance <> COALESCE(r.reserved_amount, 0);

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Wallet reservation migration aborted: % wallet(s) have locked_balance != active reservation total', mismatch_count;
  END IF;
END $$;
