import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { DatabaseService } from "./database/database.service";
import { WalletsController } from "./wallets/wallets.controller";
import { WageringController } from "./wagering/wagering.controller";

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [DatabaseService],
})
export class AppModule {}
