import type { InboxRecord } from "../schemas/message.schema";
import type { TransactionResult } from "../../wagering/contracts/transaction-result";

export class InboxMessage {
  private constructor(private readonly state: InboxRecord) {}
  static receive(consumerName: string, messageId: string, payloadHash: string) {
    return new InboxMessage({
      consumerName,
      messageId,
      payloadHash,
      receivedAt: new Date(),
      processedAt: null,
      response: null,
    });
  }
  static rehydrate(state: InboxRecord) {
    return new InboxMessage(structuredClone(state));
  }
  isProcessed() {
    return this.state.processedAt !== null;
  }
  markProcessed(response: TransactionResult, at = new Date()) {
    if (this.isProcessed()) throw new Error("Inbox message already processed");
    this.state.processedAt = new Date(at);
    this.state.response = structuredClone(response);
  }
  toRecord(): InboxRecord {
    return structuredClone(this.state);
  }
}
