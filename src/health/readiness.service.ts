import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { DatabaseService } from "../database/database.service";
import { createSqsClient, findQueues } from "../messaging/transport/sqs";

@Injectable()
export class ReadinessService implements OnApplicationShutdown {
  private readonly client = createSqsClient();
  constructor(
    @Inject(DatabaseService)
    private readonly database: Pick<DatabaseService, "createEntityManager">,
  ) {}
  async check() {
    const postgres = this.database
      .createEntityManager()
      .transactional(async (em) => {
        await em.execute("SET LOCAL statement_timeout = '2000ms'");
        await em.execute("SELECT 1");
      });
    const results = await Promise.allSettled([postgres, this.checkQueues()]);
    const dependencies = {
      postgres: results[0]!.status === "fulfilled" ? "up" : "down",
      sqs: results[1]!.status === "fulfilled" ? "up" : "down",
    };
    return {
      status:
        dependencies.postgres === "up" && dependencies.sqs === "up"
          ? "ok"
          : "unavailable",
      dependencies,
    };
  }
  private async checkQueues() {
    const signal = AbortSignal.timeout(2500);
    const queues = await findQueues(this.client, undefined, signal);
    await Promise.all(
      Object.values(queues).map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: signal },
        ),
      ),
    );
  }
  onApplicationShutdown() {
    this.client.destroy();
  }
}
