import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { domainEventOutbox } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function enqueueDomainEvent(
  tx: Tx,
  event: { aggregateType: string; aggregateId: string; eventType: string; eventVersion?: number; payload: Record<string, unknown> },
) {
  return tx.insert(domainEventOutbox).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    eventVersion: event.eventVersion ?? 1,
    payload: event.payload,
  }).returning({ id: domainEventOutbox.id });
}

export async function claimDomainEvents(limit = 100) {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id FROM domain_event_outbox
      WHERE published_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY occurred_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 500)}
    `);
    const ids = rows.rows.map((row) => String((row as { id: string }).id));
    if (!ids.length) return [];
    await tx.update(domainEventOutbox)
      .set({ attemptCount: sql`${domainEventOutbox.attemptCount} + 1`, nextAttemptAt: sql`now() + interval '30 seconds'` })
      .where(sql`${domainEventOutbox.id} = ANY(${ids}::uuid[])`);
    return tx.select().from(domainEventOutbox).where(sql`${domainEventOutbox.id} = ANY(${ids}::uuid[])`).orderBy(asc(domainEventOutbox.occurredAt));
  });
}

export async function markDomainEventPublished(id: string) {
  await db.update(domainEventOutbox).set({ publishedAt: new Date(), nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null }).where(eq(domainEventOutbox.id, id));
}

export async function markDomainEventFailed(id: string, code: string, message: string) {
  await db.update(domainEventOutbox).set({ lastErrorCode: code.slice(0, 80), lastErrorMessage: message.slice(0, 2000), nextAttemptAt: sql`now() + interval '30 seconds'` }).where(eq(domainEventOutbox.id, id));
}
