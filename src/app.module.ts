import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { DatabaseService } from "./database/database.service";
import { WalletsController } from "./wallets/wallets.controller";

@Module({
  controllers: [HealthController, WalletsController],
  providers: [DatabaseService],
})
export class AppModule {}
