import "reflect-metadata";
import { expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import { WalletSchema } from "./wallet.schema";

test("HTTP rejeita valores inválidos sem criar carteira", async () => {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    await app.listen(0, "127.0.0.1");

    const url = await app.getUrl();
    const playerId = crypto.randomUUID();

    const invalidAmounts = [100, "-10.00", "1.999", "1e2"];

    for (const amount of invalidAmounts) {
      const response = await fetch(`${url}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount, currency: "BRL" },
        }),
      });

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toMatchObject({ code: "INVALID_PAYLOAD" });
    }

    const database = app.get(DatabaseService);
    const em = database.createEntityManager();

    const createdWallets = await em.count(WalletSchema, {
      playerId,
    });

    expect(createdWallets).toBe(0);
  } finally {
    await app.close();
  }
}, 10000);
