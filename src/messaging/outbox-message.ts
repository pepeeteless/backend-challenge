import type { IntegrationEvent } from "./integration-event";
import type { OutboxRecord } from "./message.schema";

export class OutboxMessage {
  private constructor(private readonly state: OutboxRecord) {}
  static enqueue(event: IntegrationEvent<unknown>) {
    const payload = event.toJSON();
    return new OutboxMessage({ id: payload.eventId, aggregateId: payload.aggregateId,
      eventType: payload.eventType, payload, occurredAt: new Date(payload.occurredAt),
      attempts: 0, nextAttemptAt: new Date(payload.occurredAt), publishedAt: null });
  }
  static rehydrate(state: OutboxRecord) { return new OutboxMessage(structuredClone(state)); }
  isPending() { return this.state.publishedAt === null; }
  isDue(now: Date) { return this.isPending() && this.state.nextAttemptAt <= now; }
  markPublished(at: Date) {
    if (!this.isPending()) throw new Error("Outbox message already published");
    this.state.publishedAt = new Date(at);
  }
  scheduleRetry(now: Date) {
    if (!this.isPending()) throw new Error("Outbox message already published");
    this.state.attempts += 1;
    this.state.nextAttemptAt = new Date(now.getTime() + Math.min(60, 2 ** Math.min(this.state.attempts, 6)) * 1000);
  }
  toRecord(): OutboxRecord { return structuredClone(this.state); }
}
