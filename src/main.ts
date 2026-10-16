import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { logEvent, errorCode } from "./observability/logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  app.enableShutdownHooks();

  await app.listen(3000, "0.0.0.0");
  logEvent("application_started");
}

bootstrap().catch((error: unknown) => {
  logEvent("application_start_failed", { code: errorCode(error) }, "error");
  process.exitCode = 1;
});
