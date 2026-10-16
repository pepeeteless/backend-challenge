import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient } from "@aws-sdk/client-sqs";
import type { EntityManager } from "@mikro-orm/postgresql";
import { createHash } from "node:crypto";
import { ProcessTransaction, WagerRequestError } from "../wagering/process-transaction";
import { InboxConflictError } from "./message.repository";
import type { QueueUrls } from "./sqs";
import { operationalMetrics } from "../observability/metrics";
import { logEvent, type LogFields } from "../observability/logger";
import { parseWagerEnvelope } from "./wager-envelope";

export class SqsConsumer {
  constructor(private readonly em: EntityManager, private readonly client: SQSClient, private readonly queues: QueueUrls) {}

  async receive(): Promise<Message | undefined> {
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queues.transactions,
      MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 30,
      MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"] }));
    return result.Messages?.[0];
  }

  async process(message: Message) {
    const envelope = parseWagerEnvelope(message.Body);
    const { idempotencyKey, ...input } = envelope.data;
    const result = await new ProcessTransaction(this.em.fork()).execute(input, idempotencyKey, {
      consumerName: "wager-transactions", messageId: envelope.messageId,
    });
    return result;
  }

  async acknowledge(message: Message) {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.transactions, ReceiptHandle: message.ReceiptHandle }));
  }

  async consumeOnce(): Promise<boolean> {
    const message = await this.receive();
    if (!message) return false;
    const fields: LogFields = { messageId: message.MessageId };
    try {
      const envelope = parseWagerEnvelope(message.Body);
      fields.messageId = envelope.messageId;
      if (typeof envelope.data.walletId === "string") fields.walletId = envelope.data.walletId;
      if (typeof envelope.data.providerId === "string") fields.providerId = envelope.data.providerId;
    } catch {  }
    let renewing = Promise.resolve();
    const renewal = setInterval(() => {
      renewing = renewing.then(async () => {
        await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.transactions,
          ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 30 }));
      }).catch(() => logEvent("visibility_renewal_failed", { messageId: message.MessageId }, "error"));
    }, 10000);
    try {
      try {
        await this.process(message);
      } finally {
        clearInterval(renewal);
        await renewing;
      }
      await this.acknowledge(message);
    } catch (error) {
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      const permanent = error instanceof WagerRequestError || error instanceof InboxConflictError;
      if (permanent || attempts >= 5) {
        await this.client.send(new SendMessageCommand({ QueueUrl: this.queues.deadLetters,
          MessageBody: message.Body ?? "", MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid",
          MessageDeduplicationId: createHash("sha256").update(message.MessageId ?? message.Body ?? "").digest("hex") }));
        operationalMetrics.dlq += 1;
        logEvent("sqs_dlq", { ...fields, attempts }, "error");
        await this.acknowledge(message);
      } else {
        await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.transactions,
          ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: Math.min(60, 2 ** attempts) }));
        operationalMetrics.retry("sqs");
        logEvent("sqs_retry", { ...fields, attempts }, "error");
      }
    }
    return true;
  }
}
