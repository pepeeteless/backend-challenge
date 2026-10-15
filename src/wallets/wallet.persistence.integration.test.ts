import { expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../database/orm.config";
import { WalletSchema } from "./wallet.schema";
import { Money } from "./money";
import { Wallet } from "./wallet";

test("persiste e relê saldo exato como string no PostgreSQL", async () => {
  const orm = await MikroORM.init(config);
  const em = orm.em.fork();

  try {
    await em.begin();

    const id = crypto.randomUUID();
    const amount = "9007199254740993.01";

    const record = em.create(WalletSchema, {
      id,
      playerId: crypto.randomUUID(),
      currency: "BRL",
      balance: amount,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    em.persist(record);
    await em.flush();
    em.clear();

    const loaded = await em.findOneOrFail(WalletSchema, { id });

    const wallet = Wallet.rehydrate({
      id: loaded.id,
      playerId: loaded.playerId,
      currency: loaded.currency,
      balance: Money.from({
        amount: loaded.balance,
        currency: loaded.currency,
      }),
      version: loaded.version,
      createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt,
    });

    expect(wallet.id).toBe(id);
    expect(wallet.balance.toJSON().amount).toBe(amount);
    expect(wallet.version).toBe(loaded.version);

    expect(typeof loaded.balance).toBe("string");
    expect(loaded.balance).toBe(amount);
    expect(loaded.currency).toBe("BRL");
    expect(loaded.version).toBe(1);
    expect(wallet.createdAt.getTime()).toBe(loaded.createdAt.getTime());
    expect(wallet.updatedAt.getTime()).toBe(loaded.updatedAt.getTime());
  } finally {
    try {
      if (em.isInTransaction()) {
        await em.rollback();
      }
    } finally {
      await orm.close();
    }
  }
}, 10000);
