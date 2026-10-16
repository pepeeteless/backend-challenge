import { EntitySchema } from "@mikro-orm/core";
import type { TransactionResult } from "../../wagering/contracts/transaction-result";

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
  response: TransactionResult | null;
}
export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}
export const InboxSchema = new EntitySchema<InboxRecord>({
  name: "InboxRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true, length: 100 },
    messageId: { type: "string", primary: true, length: 200 },
    payloadHash: { type: "string", length: 64 },
    receivedAt: { type: Date, columnType: "timestamptz" },
    processedAt: { type: Date, columnType: "timestamptz", nullable: true },
    response: { type: "json", nullable: true },
  },
});
export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: "OutboxRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string", length: 100 },
    payload: { type: "json" },
    occurredAt: { type: Date, columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: Date, columnType: "timestamptz" },
    publishedAt: { type: Date, columnType: "timestamptz", nullable: true },
  },
});
