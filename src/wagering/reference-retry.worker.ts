import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ProcessTransaction } from "./process-transaction";
import { WagerTransactionRepository } from "./wager-transaction.repository";
import { logEvent } from "../observability/logger";

@Injectable()
export class ReferenceRetryWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    @Inject(DatabaseService)
    private readonly database: Pick<DatabaseService, "createEntityManager">,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.REFERENCE_WORKER_ENABLED === "false") return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch(() => this.logFailure())
        .finally(() => {
          this.running = undefined;
        });
    }, 1000);
    this.timer.unref();
  }

  async runOnce(now = new Date()): Promise<void> {
    const repository = new WagerTransactionRepository(
      this.database.createEntityManager(),
    );
    const due = await repository.findDue(now);
    for (const { id } of due) {
      try {
        await new ProcessTransaction(
          this.database.createEntityManager(),
        ).retryPending(id, now);
      } catch {
        this.logFailure(id);
      }
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private logFailure(transactionId?: string): void {
    logEvent("reference_retry_failed", { transactionId }, "error");
  }
}
