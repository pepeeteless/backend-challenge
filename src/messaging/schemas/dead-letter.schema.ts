import { EntitySchema } from "@mikro-orm/core";

export interface DeadLetterRecord {
  messageId: string;
  queueUrl: string;
  body: string;
  outcome: string;
  transactionId: string | null;
  archivedAt: Date;
}
export const DeadLetterSchema = new EntitySchema<DeadLetterRecord>({
  name: "DeadLetterRecord",
  tableName: "dead_letter_messages",
  properties: {
    messageId: { type: "string", length: 100, primary: true },
    queueUrl: { type: "text" },
    body: { type: "text" },
    outcome: { type: "string", length: 50 },
    transactionId: { type: "uuid", nullable: true },
    archivedAt: { type: Date, columnType: "timestamptz" },
  },
});
