import { MikroORM } from "@mikro-orm/postgresql";
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import config from "./orm.config";
import { logEvent } from "../observability/logger";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private orm!: MikroORM;

  async onModuleInit(): Promise<void> {
    this.orm = await MikroORM.init({ ...config, logger: () => logEvent("orm_diagnostic", {}, "error") });
    logEvent("database_initialized");
  }

  createEntityManager() {
    return this.orm.em.fork();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm?.close();
  }
}
