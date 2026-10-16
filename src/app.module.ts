import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { DatabaseService } from "./database/database.service";
import { WalletsController } from "./wallets/controllers/wallets.controller";
import { WageringController } from "./wagering/controllers/wagering.controller";
import { ReferenceRetryWorker } from "./wagering/workers/reference-retry.worker";
import { MessagingWorker } from "./messaging/workers/messaging.worker";
import { TransactionQueriesController } from "./wagering/controllers/transaction-queries.controller";
import { MetricsController } from "./observability/metrics.controller";
import { ReadinessService } from "./health/readiness.service";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";

@Module({
  controllers: [HealthController, WalletsController, WageringController, TransactionQueriesController, MetricsController],
  providers: [DatabaseService, ReferenceRetryWorker, MessagingWorker, ReadinessService, ProviderAuthGuard],
})
export class AppModule {}
