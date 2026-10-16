import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { OutboxSchema } from "./message.schema";
import { OutboxMessage } from "./outbox-message";
import { sendJson } from "./sqs";
import { operationalMetrics } from "../observability/metrics";
import { logEvent } from "../observability/logger";

export class OutboxPublisher {
  constructor(private readonly em: EntityManager, private readonly client: SQSClient, private readonly queueUrl: string) {}

  async publishOnce(now = new Date()): Promise<boolean> {
    return this.em.transactional(async (em) => {
      const record = await em.findOne(OutboxSchema, { publishedAt: null, nextAttemptAt: { $lte: now } }, {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, orderBy: { nextAttemptAt: "asc", id: "asc" }, refresh: true,
      });
      if (!record) return false;
      const message = OutboxMessage.rehydrate(record);
      try {
        await sendJson(this.client, this.queueUrl, record.payload, record.aggregateId, record.id);
        message.markPublished(new Date());
      } catch {
        message.scheduleRetry(now);
        operationalMetrics.retry("outbox");
        logEvent("outbox_retry", { eventId: record.id, walletId: record.aggregateId,
          correlationId: typeof record.payload.correlationId === "string" ? record.payload.correlationId : undefined }, "error");
      }
      Object.assign(record, message.toRecord());
      await em.flush();
      return true;
    });
  }
}
