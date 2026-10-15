import { expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "./orm.config";

const scenarios = [
  {
    name: "impede alterar um lançamento",
    sql: `
      UPDATE wallet_ledger_entries
      SET amount = amount
      WHERE id = ?
    `,
    error: "Ledger entries are immutable",
  },
  {
    name: "impede excluir um lançamento",
    sql: "DELETE FROM wallet_ledger_entries WHERE id = ?",
    error: "Ledger entries are immutable",
  },
  {
    name: "rejeita lançamento cuja conta não fecha",
    sql: `
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, currency,
        amount, balance_before, balance_after
      )
      SELECT
        gen_random_uuid(), wallet_id, gen_random_uuid(),
        'CREDIT', currency, 100.00, 0.00, 90.00
      FROM wallet_ledger_entries
      WHERE id = ?
    `,
    error: "ledger_arithmetic_valid",
  },
];

test.each(scenarios)(
  "$name",
  async ({ sql, error }) => {
    const orm = await MikroORM.init(config);
    const em = orm.em.fork();

    try {
      await em.begin();

      const walletId = crypto.randomUUID();
      const entryId = crypto.randomUUID();

      await em.execute(
        `INSERT INTO wallets (id, player_id, currency, balance)
       VALUES (?, ?, 'BRL', 100.00)`,
        [walletId, crypto.randomUUID()],
      );

      await em.execute(
        `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, currency,
         amount, balance_before, balance_after
       )
       VALUES (?, ?, ?, 'CREDIT', 'BRL', 100.00, 0.00, 100.00)`,
        [entryId, walletId, crypto.randomUUID()],
      );

      await expect(em.execute(sql, [entryId])).rejects.toThrow(error);
    } finally {
      try {
        if (em.isInTransaction()) {
          await em.rollback();
        }
      } finally {
        await orm.close();
      }
    }
  },
  10000,
);
