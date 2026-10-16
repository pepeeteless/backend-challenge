import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { createSqsClient, findQueues, type QueueUrls } from "./sqs";
import { SqsConsumer } from "./sqs.consumer";
import { OutboxPublisher } from "./outbox.publisher";
import { logEvent } from "../observability/logger";
import { DeadLetterConsumer } from "./dead-letter.consumer";

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
      for (
        let i = 0;
        i < 20 && !this.stopping && (await publisher.publishOnce());
        i++
      ) {}
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
    return (this.queues ??= await findQueues(this.client));
  }
  async beforeApplicationShutdown() {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled(this.running);
    this.client.destroy();
  }
}
