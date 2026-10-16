import { expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../open-wallet";
import config from "../../database/orm.config";

test.each([
  { amount: "100.00", entries: "1" },
  { amount: "0.00", entries: "0" },
])(
  "abre carteira com saldo $amount",
  async ({ amount, entries }) => {
    const orm = await MikroORM.init(config);
    const em = orm.em.fork();

    try {
      await em.begin();

      const wallet = await new OpenWallet(em).execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount, currency: "BRL" },
      });

      const rows = await em.execute(
        `
      SELECT
        w.balance::text AS balance,
        w.version,
        (
          SELECT count(*)::text
          FROM wager_transactions t
          WHERE t.wallet_id = w.id AND t.kind = 'OPENING'
        ) AS openings,
        (
          SELECT count(*)::text
          FROM wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS entries,
        (
          SELECT coalesce(sum(
            CASE WHEN l.direction = 'CREDIT'
              THEN l.amount ELSE -l.amount END
          ), 0) = w.balance
          FROM wallet_ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS consistent
      FROM wallets w
      WHERE w.id = ?
    `,
        [wallet.id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].balance).toBe(amount);
      expect(rows[0].version).toBe(1);
      expect(rows[0].openings).toBe(entries);
      expect(rows[0].entries).toBe(entries);
      expect(rows[0].consistent).toBe(true);
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
