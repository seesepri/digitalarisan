-- v17 performance/scalability indexes. No financial/accounting semantics are changed.
-- All indexes are additive and support existing cursor pagination, retry scans and joins.
CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_id_idx ON wallet_transactions (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wallet_reservations_user_status_created_idx ON wallet_reservations (user_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS topups_user_created_id_idx ON topups (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS topups_status_expires_idx ON topups (status, expires_at);
CREATE INDEX IF NOT EXISTS withdrawals_user_created_id_idx ON withdrawals (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS withdrawals_status_retry_idx ON withdrawals (status, next_retry_at);
CREATE INDEX IF NOT EXISTS arisan_periods_status_drawing_id_idx ON arisan_periods (status, drawing_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS arisan_participants_user_status_created_idx ON arisan_participants (user_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_account_created_id_idx ON financial_transactions (account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_created_id_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_created_idx ON notifications (user_id, read_at, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_id_idx ON audit_logs (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_created_id_idx ON audit_logs (entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS compliance_flags_status_created_id_idx ON compliance_flags (status, created_at DESC, id DESC);
