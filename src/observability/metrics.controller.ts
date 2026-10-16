import { UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../auth/provider-auth.guard";
import { Controller, Get, Header, Inject, UseFilters } from "@nestjs/common";
import { raw } from "@mikro-orm/core";
import { reconciliationMetrics, operationalMetrics } from "./metrics";
import { DatabaseService } from "../database/database.service";
import { DatabaseHttpFilter } from "../database/filters/database-http.filter";
import { WagerTransactionSchema } from "../wagering/schemas/wager-transaction.schema";
import { OutboxSchema } from "../messaging/schemas/message.schema";
import {
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient, queueNames } from "../messaging/transport/sqs";
import { DeadLetterSchema } from "../messaging/schemas/dead-letter.schema";

@Controller("metrics")
@UseFilters(DatabaseHttpFilter)
@UseGuards(ProviderAuthGuard)
export class MetricsController {
  private readonly client = createSqsClient();
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  onApplicationShutdown() {
    this.client.destroy();
  }

  private async dlqMetrics(): Promise<string> {
    const signal = AbortSignal.timeout(2500);
    try {
      const { QueueUrl } = await this.client.send(
        new GetQueueUrlCommand({
          QueueName: queueNames(process.env.SQS_QUEUE_PREFIX ?? "wager")
            .deadLetters,
        }),
        { abortSignal: signal },
      );
      const { Attributes } = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
        { abortSignal: signal },
      );
      const visible = Attributes?.ApproximateNumberOfMessages;
      const inFlight = Attributes?.ApproximateNumberOfMessagesNotVisible;
      if (visible === undefined || inFlight === undefined)
        throw new Error("Missing queue metrics");
      return `# TYPE sqs_metrics_up gauge\nsqs_metrics_up 1\n# TYPE sqs_dlq_messages gauge\nsqs_dlq_messages ${Number(visible) + Number(inFlight)}\n`;
    } catch {
      return "# TYPE sqs_metrics_up gauge\nsqs_metrics_up 0\n";
    }
  }
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics() {
    const em = this.database.createEntityManager();
    const statuses: Array<{ status: string; count: number }> = await em
      .createQueryBuilder(WagerTransactionSchema)
      .select(["status", raw("count(*)::integer as count")])
      .groupBy("status")
      .execute("all");
    const oldest = await em.findOne(
      OutboxSchema,
      { publishedAt: null },
      { orderBy: { occurredAt: "asc" }, fields: ["occurredAt"] },
    );
    const pending = await em.count(OutboxSchema, { publishedAt: null });
    const archived = await em.count(DeadLetterSchema, {});
    let output =
      reconciliationMetrics.render() +
      operationalMetrics.render() +
      "# TYPE wager_transactions gauge\n";
    for (const status of [
      "PENDING",
      "PENDING_REFERENCE",
      "PROCESSED",
      "REJECTED",
      "FAILED",
    ]) {
      output += `wager_transactions{status="${status}"} ${statuses.find((row) => row.status === status)?.count ?? 0}\n`;
    }
    return (
      output +
      `# TYPE dead_letter_archived gauge\ndead_letter_archived ${archived}\n` +
      `# TYPE outbox_pending gauge\noutbox_pending ${pending}\n` +
      `# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds ${oldest ? Math.max(0, (Date.now() - oldest.occurredAt.getTime()) / 1000) : 0}\n` +
      (await this.dlqMetrics())
    );
  }
}
