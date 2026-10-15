import { Module } from "@nestjs/common";
import { HealthController } from "./infra/http/health.controller";

@Module({
  controllers: [HealthController],
})
export class AppModule {}
