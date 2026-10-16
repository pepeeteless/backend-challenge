import { EntityManager } from "@mikro-orm/postgresql";
import { createHash } from "node:crypto";
import { InboxMessage } from "./inbox-message";
import { OutboxMessage } from "./outbox-message";
import { InboxSchema, OutboxSchema } from "./message.schema";
import type { IntegrationEvent } from "./integration-event";
import type { TransactionResult } from "../wagering/transaction-result";

export interface MessageContext {
  consumerName: string;
  messageId: string;
}
export class InboxConflictError extends Error {}

export class MessageRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(
    context: MessageContext,
    businessHash: string,
    key: string,
  ): Promise<TransactionResult | null> {
    const hash = createHash("sha256")
      .update(JSON.stringify([businessHash, key]))
      .digest("hex");
    const message = InboxMessage.receive(
      context.consumerName,
      context.messageId,
      hash,
    );
    const inserted = await this.em
      .createQueryBuilder(InboxSchema)
      .insert(message.toRecord())
      .onConflict()
      .ignore()
      .returning(["messageId"])
      .execute("all");
    if (inserted.length) return null;
    const existing = await this.em.findOneOrFail(InboxSchema, context, {
      refresh: true,
    });
    if (existing.payloadHash !== hash)
      throw new InboxConflictError("INBOX_PAYLOAD_CONFLICT");
    if (!existing.response) throw new Error("Committed inbox has no response");
    return { ...existing.response, idempotentReplay: true };
  }

  async complete(context: MessageContext, result: TransactionResult) {
    const record = await this.em.findOneOrFail(InboxSchema, context);
    const message = InboxMessage.rehydrate(record);
    message.markProcessed(result);
    Object.assign(record, message.toRecord());
    await this.em.flush();
  }

  async enqueue(event: IntegrationEvent<unknown>) {
    this.em.persist(
      this.em.create(OutboxSchema, OutboxMessage.enqueue(event).toRecord()),
    );
    await this.em.flush();
  }
}
