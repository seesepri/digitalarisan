# PostgreSQL Disaster Recovery Operations

## Recovery objectives

Default production targets for this project:

- **RPO:** <= 5 minutes when continuous WAL archiving is healthy.
- **RTO:** <= 60 minutes for a full database restore, subject to provider/object-storage performance.
- **Backup retention:** minimum 14 days for logical backups; physical/WAL retention follows the approved DR policy.

These are targets, not guarantees. They must be measured during scheduled restore drills.

## Backup layers

1. Managed PostgreSQL snapshots or pgBackRest physical backups.
2. Continuous WAL archiving for PITR.
3. Daily logical `pg_dump` custom-format backup using `scripts/backup-postgres.sh`.
4. SHA-256 checksum and archive listing for every logical backup.
5. At least one backup copy in a separate failure domain/account.

Never keep database backups or provider credentials only on the application host.

## PITR

Use `scripts/pitr-restore.sh` with a pgBackRest repository. Restore into an isolated PostgreSQL instance first. Never promote a PITR instance directly to production without validation.

## Restore validation

After starting the restored database:

```bash
DATABASE_URL='postgresql://...' ./scripts/dr/verify-restored-db.sh
DATABASE_URL='postgresql://...' ./scripts/dr/migration-preflight.sh
```

Then run the v11 integration suite against the restored database and run the accounting reconciliation endpoint/job before reopening traffic.

## Migration recovery

1. Freeze application writes.
2. Record the exact application release and database migration state.
3. Take a final backup/snapshot if the database is still healthy.
4. Restore to an isolated database when possible.
5. Validate migration journal and sequential migration files.
6. Never edit an already-applied migration in place.
7. If a migration is faulty, deploy a forward corrective migration or restore to a known-good point and redeploy the matching application release.
8. Run reconciliation and the complete integration suite before cutover.

## Backup verification cadence

- Every backup: checksum + `pg_restore --list`.
- Daily: automated restore smoke test to an isolated database.
- Weekly: full restore drill.
- Monthly: PITR drill to a selected timestamp.
- Quarterly: region/failure-domain recovery exercise.

## DR cutover

```text
Detect incident
  -> freeze writes / disable financial mutations
  -> identify last known good WAL timestamp
  -> restore isolated database
  -> run integrity + reconciliation + integration tests
  -> validate payment/payout provider idempotency state
  -> switch DATABASE_URL / traffic
  -> monitor metrics and alerts
  -> resume writes gradually
```

Do not manually edit wallet balances, financial accounts, reservations, or immutable ledgers during recovery. Corrections must use the application's append-only/reversal/reconciliation mechanisms.
