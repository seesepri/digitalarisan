# DigitalArisan / Seearisan — Audit, patch, dan verifikasi lokal

**Tanggal:** 13 Oktober 2026
**Baseline Git:** `b85e7573d6252f7b44354ca6ded05dd8ce2ee554`
**Instruksi audit:** `step7b/promt.md`
**Kesimpulan release:** **BELUM PRODUCTION-READY — BLOCKED.**

Audit dilanjutkan dengan perubahan source dan pengujian nyata di PostgreSQL terisolasi, bukan rekomendasi saja. Patch tersedia dalam working copy workspace; **belum dibuat commit atau push ke remote**. Git awal bersih. File SQL baseline `0000` dan `0001` tidak diubah. Semua operasi finansial dan restore yang diuji memakai data sintetis di cluster lokal milik audit. **Tidak ada akses/mutasi saldo atau status finansial asli, retry payout asli, refund asli, maupun deployment production.**

## 1. Ringkasan hasil

- **PASS:** lint, typecheck, production build Next.js 16.4, **111 pemeriksaan unit/source** dan **43 pemeriksaan TAP PostgreSQL**; seluruh suite lokal tersebut 0 gagal/0 skipped.
- **PASS:** migration files dan applied journal enam migrasi; fresh bootstrap; upgrade dari baseline repository; sinkronisasi snapshot ORM; applied-hash mismatch ditolak.
- **PASS:** financial concurrency, crash recovery, provider evidence/fencing, retry deadline, accounting/reservation checks, beneficiary intent, early webhook dan late PAID, ledger/audit causal ordering, refresh rotation/logout, durable job lease, least-privilege role.
- **PASS:** standalone production-build HTTP smoke pada database uji dan role aplikasi bukan owner; dua tes HTTP smoke/load, 200 health reads dengan concurrency 20 dan 0 error. Ini bukan benchmark kapasitas transaksi finansial production.
- **PASS:** logical backup/restore sintetis; seluruh isi 33 tabel identik, termasuk saldo nonzero, tiga wallet ledger entries, enam audit entries dan migration journal. Ciphertext bank dapat didekripsi dengan **kunci uji asli**.
- **PASS:** production dependency audit: 0 temuan.
- **FAIL:** full dependency/release gate: **5 HIGH, 0 MODERATE, 0 CRITICAL**, pada dependency chain `braces → micromatch → fast-glob → Next ESLint`. Dikurangi dari 9 temuan awal. Tidak disembunyikan dan tidak memakai `audit fix --force`.
- **BLOCKED:** sembilan withdrawal asli, provider sandbox/settlement aktual, production roles/secrets/TLS, legacy history, PITR/WAL dan production RPO/RTO. Build/test lokal bukan bukti bank telah mentransfer dana.

Jumlah pemeriksaan mengikuti hitungan TAP runner; unit/source mencakup assertion statis dan PostgreSQL integration mencakup container test. Dua tes HTTP terpisah tidak dicampur ke angka 154 pemeriksaan core.

## 2. Baseline read-only dan temuan

Baseline: typecheck/lint/build serta production audit lulus, tetapi checksum verifier gagal dan full dependency audit menemukan 9 vulnerability entries. Broad tests: 90 pass, 3 fail, 1 skipped. Pada cluster PostgreSQL baru: concurrency 3/8 pass, crash 0/4 pass, integration TAP 3 pass/5 fail. Sebagian kegagalan adalah fixture/environment yang salah—PII key, reviewer KYC, tanggal periode, maker/checker, ekspektasi ledger—bukan bukti kegagalan di production. Fixture diperbaiki, guard lingkungan diperketat, dan behavioral regression ditambahkan tanpa menonaktifkan tes atau melonggarkan security checks.

| Prioritas | Root cause / risiko yang ditemukan pada source | Patch dan verifikasi |
|---|---|---|
| P0 | Terminal withdrawal tidak mengikat bukti provider lengkap; referensi dapat tidak tersimpan bersama finalisasi | Bukti wajib mengikat provider, merchant reference WD stabil, external reference, safe integer amount, IDR, status dan confirmed failure; state/ledger/attempt/audit commit atomik. Concurrent success/failure 20 request menghasilkan satu efek. |
| P0 | Timeout/404/malformed response dapat diperlakukan seperti kegagalan transfer yang aman di-retry/refund | `UNKNOWN` bukan gagal final. `PROCESSING` inquiry-only; tidak create ulang karena 404. Timeout setelah simulated external acceptance dipulihkan lewat inquiry. Dana tetap ditahan jika ambigu. |
| P0 | Respons attempt lama dan duplicate executor dapat mengganggu state baru | Expected attempt fencing, row locks, immutable provider identity/reference, terminal guards. Lost/stale result ditolak; duplicate in-flight executor tidak mengirim POST payout kedua. |
| P0 | Deadline/budget retry serta metadata final tidak konsisten | Service + PostgreSQL enforce due timestamp dan batas 5 attempt. Exhaustion hanya boleh refund setelah kegagalan transfer terkonfirmasi, memakai `PROVIDER_RETRIES_EXHAUSTED`, tanpa retry timestamp/pesan dana ditahan. |
| P0 | Default reconciliation dapat mengubah uang saat seharusnya audit | Financial recovery default off; explicit recovery memerlukan SUPER_ADMIN aktif dan bukti/fencing. Default tetap boleh mencatat reconciliation run/issues, **bukan read-only seluruh DB**. Tool investigasi terpisah benar-benar `BEGIN ... READ ONLY`. |
| P0 | Retry idempotency tidak selalu mengikat recipient/period/participant lengkap | Withdrawal key mengikat user/amount/bank/account; encrypted PII didekripsi untuk comparison. Join/cancel replay mengikat period/participant. Wallet-lock recheck mencegah race. |
| P0 | Top-up concurrent creation, webhook sebelum referensi tersimpan, dan late PAID | Intent creation diserialisasi; replay tanpa checkout melakukan inquiry, bukan create charge kedua. Signed webhook mengenali provider-scoped receipt atau UUID merchant intent; amount/currency/providernya wajib cocok. Verified late PAID setelah expiry dapat credit sekali, SUCCESS monotonik. |
| P0 | `BIGINT` money menjadi unsafe JS number; ownership/reservation kurang kuat | Safe integer reader/writer + SQL constraints; owner-composite FK; pending=sum active withdrawals dan locked=sum active reservations via deferred triggers. Invalid/unsafe/cross-owner writes diuji ditolak. |
| P1 | Transaction-start timestamps tidak membuktikan urutan ledger / audit sequence dialokasikan sebelum lock | Ledger identity sequence untuk future causal order; audit sequence dialokasikan setelah advisory lock, UTC hash canonicalization; attempt timestamps memakai `clock_timestamp()`. Timestamp inversion dan hash-lock interleaving direproduksi dalam PostgreSQL. **Metadata backfill bukan sertifikasi urutan historis.** |
| P1 | Operator correction tanpa pemeriksaan actor, domain reservation dan replay yang cukup | SUPER_ADMIN aktif wajib; reservation/withdrawal bucket movement ditolak oleh generic reversal; original-entry replay binding; unique reversal; immutable originals dan audit compensation. Bukan mekanisme refund bank atau koreksi otomatis sembilan kasus. |
| P1 | Manual job retry dapat menghapus live lease; lease kedaluwarsa bisa dihidupkan kembali | Live lease tidak boleh dioverride; renew/complete/fail harus token/status/deadline cocok. Manual mutation+audit satu transaksi. 20 competing workers memperoleh satu lease; expired/stale owner ditolak. |
| P1 | Concurrent legitimate refresh dapat revoke sesi baru/semua devices; logout old token melewatkan successor | Session family/successor/revocation metadata, user-first locking, short **deny-only 409** collision window (tidak mengautentikasi old token), modern family-scoped reuse revocation; logout mencabut successor family. Legacy tanpa provenance tetap conservative global revoke. |
| P1 | Payload dibuffer penuh; DB wrapper error membawa SQL params; identifier throttling melekat pada tuple IP | Stream limits 64 KB JSON/32 KB webhook; sanitized database errors; subject limit independen IP. Production CSRF hanya canonical HTTPS APP_URL, bukan request Host. Trusted proxy IP dihitung dari kanan dengan fixed hops; ingress tetap wajib dibatasi. |
| P1 | Restore public saja meninggalkan journal dan dapat meninggalkan partial data; checksum bisa memverifikasi file berbeda; retention menghapus arbitrary files | Restore hanya target baru/kosong/terisolasi, archive digest wajib cocok, single transaction mencakup journal, tidak drop live schema. Retention dibatasi prefix arsip. Corrupt archive dan nonempty target diuji ditolak. |
| P1 | App role dapat memiliki/inherit owner atau partial broad grants | Provisioning privilege atomik; tidak boleh database/schema/table owner/member owner, schema CREATE, ledger UPDATE/DELETE/TRUNCATE/column UPDATE; migration credentials terpisah. Runtime role diuji tidak dapat disable trigger, truncate, set replication bypass atau akses journal. |
| P1 | Deployment dapat menganggap SELECT 1 / build sebagai production readiness; encryption dijalankan setelah immutable guard | Promotion membutuhkan approved release reference, seluruh migrations applied dan local integrity/hash gates; pesan health bukan sertifikasi. Schema apply explicit approval + frozen financial workers; initial plaintext encryption sebelum 0002 dan terpisah dari key rotation. Tidak dijalankan di production. |
| P2 | Deprecated middleware/root inference dan telemetry cardinality | Next 16 `proxy.ts`, explicit project root tanpa menghapus root lockfile pengguna; bounded telemetry series. Build akhir tidak memiliki warning baseline tersebut. |

Temuan source di atas adalah kandidat penjelasan untuk pola sembilan withdrawal, **bukan root-cause final atas records asli yang belum diperoleh**.

## 3. Sembilan withdrawal asli: BLOCKED, tidak dikoreksi

| Kasus dari prompt | Bukti lokal yang dibutuhkan | Bukti eksternal yang harus diperoleh sebelum keputusan uang |
|---|---|---|
| 5 `SUCCESS` tanpa `provider_reference` | IDs, state/attempt timeline, ledger/reservation, audit, merchant request/idempotency references | Provider receipt/transfer lookup; amount, IDR, intended beneficiary dan final settlement/bank statement. DB SUCCESS saja tidak cukup. |
| 4 `FAILED_FINAL` dengan error retryable/pesan dana ditahan | IDs, bucket balances, refund/reserve entries, final attempts dan audit | Confirmed failed/non-transferred outcome atau actual paid transfer. Pesan error tidak membuktikan uang sudah refund maupun gagal ditransfer. |
| Retry terlihat sebelum `next_retry_at` | Failure-attempt deadline dibanding subsequent processing timestamps | Actual provider/app logs dan wall-clock timeline; legacy `now()` transaction-start timestamp bisa membuat apparent early history. |

Disediakan `scripts/security/audit-withdrawals.mjs`: snapshot repeatable-read/read-only, tanpa provider call, retry, refund atau update. Mengeluarkan IDs/amount/status/attempt/ledger/audit/wallet checks tanpa bank PII, memakai credential read-only tersendiri. Reference WD yang diturunkan adalah **request-reference candidate, bukan external receipt**.

```bash
# Jalankan oleh operator pada host aman dengan SELECT-only credential, bukan menempel credential ke chat.
READ_ONLY_AUDIT_DATABASE_URL="$READ_ONLY_URL" \
AUDIT_OUTPUT_FILE=withdrawal-investigation.json \
node scripts/security/audit-withdrawals.mjs <UUID_ASLI_1> <UUID_ASLI_2>
```

Tanpa IDs, tool mencari anomalies dan membatasi output 200 records dengan total/truncation indicator. Rehearsal sengaja membuat **sembilan baris sintetis**, bukan records pengguna, dan membuktikan migration/read-only audit tidak mengubah status, saldo, reference atau failure metadata. Constraint validation legacy bad rows **harus gagal**. Hasil fixture diberi label `notTheUsersActualNineWithdrawals: true`.

Setelah bukti eksternal diperoleh: review tiap case dan history, verifikasi recipient/reference/amount, tentukan accounting delta yang benar, mintakan maker/checker approval, uji recovery plan pada preserved isolated clone, kemudian append compensation/audit atomik. **Jangan mengubah ledger historis, mengisi receipt buatan, menjalankan retry massal atau refund dari status DB saja.** Recovery legacy terminal anomalies belum merupakan workflow otomatis yang siap dipakai.

## 4. Migrasi dan operasional yang berubah

- `0002`: provider evidence, identity/reference/retry/terminal guard; recipient tidak dapat diganti; clock-time attempts.
- `0003`: safe money, owner relationships, reversal/ledger ordering integrity dan serialized audit hashing.
- `0004`: deferred wallet reservation invariants.
- `0005`: session family, rotation successor/revocation reason.
- Manifest/journal enam migrasi diverifikasi. Checksum lama 0001 pada manifest salah; manifest disesuaikan terhadap SQL asli, bukan mengedit SQL baseline. Jika applied journal berbeda, **BLOCKED**—tidak boleh dibenarkan dengan mengubah hash database.
- Snapshot `0005_snapshot.json` selaras dengan declared ORM schema: generate menghasilkan “No schema changes”. Raw SQL triggers/custom constraints tetap dikelola di reviewed migrations; jangan `drizzle push` ke production.
- Constraints `NOT VALID` menjaga legacy anomalies untuk investigasi dan melindungi mutation baru. Fresh test constraints berhasil divalidasi; **tidak membuktikan historical production data valid**.
- Initial bank plaintext encryption kini dry-run default, pinned transaction client dan historical-ciphertext validation. Apply perlu approval tersendiri sebelum guard 0002. **BANK key rotation BLOCKED**: `enc:v1` tidak punya key ID/keyring; jangan mengganti/revoke kunci lama sebelum versioned recovery, data migration dan retained backup decryptability terbukti.
- Logical restore tidak menimpa database berisi data. PITR tidak lagi memakai delta overwrite/auto-promote; butuh empty isolated PGDATA/explicit consent dan pause. **WAL recovery aktual tidak diuji** karena infrastructure/archives tidak tersedia.

## 5. Evidence dan command hasil akhir

Evidence disertakan di folder `audit-evidence/` dalam paket delivery.

| Command / pemeriksaan | Status | Evidence utama |
|---|---|---|
| `npm run test:all` (lint + typecheck + unit/source + PG) | PASS | `final-all-tests.log`: 111 + 8 + 4 + 8 + 20 + 3, semua 0 fail/0 skipped |
| `npm run build` | PASS | `final-build.log`, Next 16.4 standalone |
| `npm run test:http:local` | PASS | `final-http.log`, `http-local.json`: authenticated metrics gate, unauthorized wallet/admin/jobs, production CSP, Origin rejection, 413 body limit; 2 HTTP tests |
| `npm run test:migrations` | PASS | `final-migration-rehearsal.log`, labeled synthetic-nine JSON; approved/rejected migration paths |
| `npm run test:dr` | PASS | `final-dr-rehearsal.log`, `dr-rehearsal.json`: 33 tables/3 wallet entries/6 audit entries preserved; original test key works |
| Migration file/journal verification | PASS | `final-migration-files.log`, `final-applied-journal.log` (6 applied / 0 pending) |
| Applied-hash mismatch refusal | PASS negative test | `journal-mismatch-negative.log`: expected BLOCKED at index 2; no DB mutation |
| ORM snapshot drift check | PASS | `schema-drift-check.log`: No schema changes |
| Production audit | PASS | `final-production-audit.json`: 0 vulnerabilities |
| Full audit / release security gate | FAIL | `final-dependency-audit.json`, `final-security-gate.log`: 5 HIGH |
| Provider sandbox/real bank settlement | BLOCKED | No sandbox credentials/contract certification/actual receipts provided; no real payment/payout calls |
| Production deployment, failover, key recovery, role/TLS proof | BLOCKED / NOT TESTED | Tidak ada operations terhadap production |

Toolchain akhir: **Node 20.20.2, npm 10.9.2, PostgreSQL 17.11**. Baseline memakai npm 10.8.2; release gate sekarang enforce pin 10.9.2. Scoped esbuild override benar-benar resolved ke `0.25.12` pada vulnerable core-utils branch dan diuji lewat install, build, migration/generation/tests. Latest `braces` yang diperiksa adalah `3.0.3`; tidak ditemukan published fixed upgrade yang memenuhi gate. Tidak downgrade breaking ESLint/Next atau mengabaikan advisory agar output hijau.

## 6. Reproduksi aman

Lihat `AUDIT_README.md` untuk prerequisite dan setup database bertanda disposable. Test database harus explicit loopback URL, nama berakhiran `_test`, tanpa query/host override, environment bukan production, `TEST_DB_ALLOW_RESET=YES` dan comment `digitalarisan:disposable-test`.

`test:all` menghapus fixture public tables **hanya pada disposable database tersebut**. Jangan mengarahkannya ke snapshot production/hasil restore yang ingin dipertahankan. `test:migrations` dan `test:dr` memerlukan local fixture owner yang bisa membuat temporary test databases. Pengujian memakai test-only keys dan mocks; tidak menggunakan production URL sebagai fallback.

## 7. Release checklist — belum dapat READY

- [x] Working-copy source patched; baseline SQL 0000/0001 tidak diubah.
- [x] Lint/typecheck/build dan local regression PASS; unsafe environment guards aktif.
- [x] Local SQL privilege, logical backup/restore dan HTTP security smoke PASS.
- [ ] **FAIL:** full supply-chain vulnerability gate (5 HIGH). Selesaikan upstream/toolchain dependency dengan supported, verified fix.
- [ ] **BLOCKED:** sembilan records asli dan evidence transfer/bank/provider aktual; historical corrective plan + operator approvals belum tersedia.
- [ ] **BLOCKED:** real generic payout contract—idempotency/retry behavior, stable business/external reference semantics, echoed IDR/amount/identity, confirmed failure, UNKNOWN/timeout handling—belum certified. Jika provider mengeluarkan receipt baru per retry, adapter/model attempt harus dirancang/test sesuai kontrak; jangan sekadar melonggarkan guard.
- [ ] **BLOCKED:** Midtrans/Twilio/payout sandbox success/failure/replay/refund/provider-outage E2E dan real KYC/recipient/OTP setup.
- [ ] **BLOCKED:** existing production journal adoption, legacy ledger causal order, legacy audit timezone/hash chain, constraint validation dan pending/locked reconciliation.
- [ ] **BLOCKED:** original bank-key recovery/rotation/versioning, secret manager/revoke process, backup encryption/offsite/immutability, least-privilege production role + network/TLS verification.
- [ ] **BLOCKED:** actual WAL/PITR, production RPO/RTO, freeze/provider-state reconciliation after restore dan validated recovery runbook.
- [ ] **NOT TESTED:** production promotion/rollback/canary/CI artifact provenance/signing, browser/device/cross-tab refresh coordination, real alert delivery/drill and full financial stress/capacity.
- [ ] **BLOCKED:** domain-specific financial correction beyond tested append-only local helpers. Generic reversal tidak membuktikan external refund; reserved money ditolak, dan actual compensation membutuhkan external evidence serta accounting-domain plan.

**Final verdict: BLOCKED / NOT PRODUCTION-READY.** Source-level money safeguards dan lokal regression sudah diperbaiki/dibuktikan, tetapi actual financial correctness, provider contract dan operational release gates belum semuanya terbukti. Ini bukan penetration-test report, sertifikasi bank, legal opinion atau compliance approval.

## 8. Daftar file yang berubah

Inventori lengkap ada di `changed-files.tsv` pada paket delivery. Kelompok utama:

- Financial services: `wallet.ts`, `payout-provider.ts`, `payout-withdrawal.ts`, `withdrawal-policy.ts`, `payment-provider.ts`, `provider-url.ts`, `arisan.ts`, `compliance.ts`, `ledger.ts`, `reconciliation.ts`.
- Authorization/runtime: `http.ts`, `metrics.ts`, `job-lock.ts`, `phone-verification.ts`, auth refresh/logout, sensitive admin/join/cancel/withdrawal/webhook routes, `proxy.ts` (menggantikan middleware), `next.config.ts`.
- Data: schema, migrations 0002–0005, journal/checksums, snapshot 0005.
- Test infrastructure/regressions: explicit guarded unit/database runners, financial-integrity suites, crash/concurrency/integration fixtures, provider/policy/security/environment/metrics tests, HTTP smoke/load harness, migration + DR rehearsals.
- Ops: role setup, applied-journal/integrity/audit verifiers, schema/promotion/preflight guards, backup/checksum/restore/PITR scripts, safe initial PII migration, secret-rotation warning, dependency override/lockfile/scripts.
