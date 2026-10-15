import { MikroORM } from "@mikro-orm/postgresql";
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import config from "./orm.config";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private orm!: MikroORM;
  private readonly logger = new Logger(DatabaseService.name);

  async onModuleInit(): Promise<void> {
    this.orm = await MikroORM.init(config);
    this.logger.log("PostgreSQL connected");
  }

  createEntityManager() {
    return this.orm.em.fork();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm?.close();
  }
}
