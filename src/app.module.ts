import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { DatabaseService } from "./database/database.service";
import { WalletsController } from "./wallets/wallets.controller";
import { WageringController } from "./wagering/wagering.controller";
import { ReferenceRetryWorker } from "./wagering/reference-retry.worker";
import { MessagingWorker } from "./messaging/messaging.worker";
import { TransactionQueriesController } from "./wagering/transaction-queries.controller";
import { MetricsController } from "./observability/metrics.controller";
import { ReadinessService } from "./health/readiness.service";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";

@Module({
  controllers: [HealthController, WalletsController, WageringController, TransactionQueriesController, MetricsController],
  providers: [DatabaseService, ReferenceRetryWorker, MessagingWorker, ReadinessService, ProviderAuthGuard],
})
export class AppModule {}
