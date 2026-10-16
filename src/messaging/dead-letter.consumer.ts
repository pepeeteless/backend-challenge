import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient, type Message } from "@aws-sdk/client-sqs";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ProcessTransaction, WagerRequestError } from "../wagering/process-transaction";
import { InboxConflictError } from "./message.repository";
import { parseWagerEnvelope } from "./wager-envelope";
import { DeadLetterSchema } from "./dead-letter.schema";
import { logEvent } from "../observability/logger";

export class DeadLetterConsumer {
  constructor(private readonly em: EntityManager, private readonly client: SQSClient, private readonly queueUrl: string) {}

  async archive(message: Message) {
    if (!message.MessageId) throw new Error("Missing SQS message identity");
    return this.em.transactional(async em => {
      const existing = await em.findOne(DeadLetterSchema, { messageId: message.MessageId! });
      if (existing) return existing;
      let outcome: string;
      let transactionId: string | null = null;
      try {
        const envelope = parseWagerEnvelope(message.Body);
        const { idempotencyKey, ...body } = envelope.data;
        const result = await new ProcessTransaction(em).recordFailure(body, idempotencyKey, {
          consumerName: "wager-transactions", messageId: envelope.messageId,
        });
        outcome = result.status;
        transactionId = result.transactionId;
      } catch (error) {
        if (error instanceof WagerRequestError) outcome = error.code;
        else if (error instanceof InboxConflictError) outcome = "INBOX_PAYLOAD_CONFLICT";
        else throw error;
      }
      const record = { messageId: message.MessageId!, queueUrl: this.queueUrl, body: message.Body ?? "",
        outcome, transactionId, archivedAt: new Date() };
      await em.createQueryBuilder(DeadLetterSchema).insert(record).onConflict().ignore().execute();
      return record;
    });
  }

  async consumeOnce(): Promise<boolean> {
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 30 }));
    const message = result.Messages?.[0];
    if (!message) return false;
    const archived = await this.archive(message);
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    logEvent("dead_letter_archived", { messageId: message.MessageId, transactionId: archived.transactionId, status: archived.outcome });
    return true;
  }
}
