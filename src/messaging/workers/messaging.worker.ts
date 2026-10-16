import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { createSqsClient, findQueues, type QueueUrls } from "../transport/sqs";
import { SqsConsumer } from "../consumers/sqs.consumer";
import { OutboxPublisher } from "../publishers/outbox.publisher";
import { logEvent } from "../../observability/logger";
import { DeadLetterConsumer } from "../consumers/dead-letter.consumer";

@Injectable()
export class MessagingWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly client = createSqsClient();
  private queues?: QueueUrls;
  private stopping = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Set<Promise<unknown>>();
  constructor(
    @Inject(DatabaseService)
    private readonly database: Pick<DatabaseService, "createEntityManager">,
  ) {}

  onApplicationBootstrap() {
    if (process.env.MESSAGING_WORKER_ENABLED === "false") return;
    this.schedule(async () => {
      const queues = await this.getQueues();
      await new DeadLetterConsumer(
        this.database.createEntityManager(),
        this.client,
        queues.deadLetters,
      ).consumeOnce();
    });
    this.schedule(async () => {
      const queues = await this.getQueues();
      await new SqsConsumer(
        this.database.createEntityManager(),
        this.client,
        queues,
      ).consumeOnce();
    });
    this.schedule(async () => {
      const queues = await this.getQueues();
      const publisher = new OutboxPublisher(
        this.database.createEntityManager(),
        this.client,
        queues.events,
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        if (this.stopping) break;
        const foundEvent = await publisher.publishOnce();
        if (!foundEvent) break;
      }
    });
  }
  private schedule(work: () => Promise<void>) {
    let active = false;
    const timer = setInterval(() => {
      if (active) return;
      active = true;
      const task = work()
        .catch(() => {
          logEvent("messaging_worker_unavailable", {}, "error");
        })
        .finally(() => {
          active = false;
          this.running.delete(task);
        });
      this.running.add(task);
    }, 1000);
    timer.unref();
    this.timers.push(timer);
  }
  private async getQueues() {
    if (!this.queues) {
      this.queues = await findQueues(this.client);
    }
    return this.queues;
  }
  async beforeApplicationShutdown() {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled(this.running);
    this.client.destroy();
  }
}
