import { EntityManager } from "@mikro-orm/postgresql";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.schema";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

export class LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async page(walletId: string, limit: number, token?: string) {
    const cursor = token ? decodeLedgerCursor(token, walletId) : undefined;
    const last = cursor ? null : await this.em.findOne(WalletLedgerEntrySchema, { walletId }, { orderBy: { sequence: "desc" } });
    const through = cursor?.through ?? last?.sequence;
    if (!through) return { items: [], nextCursor: null };
    const records = await this.em.find(WalletLedgerEntrySchema, {
      walletId, sequence: { $gt: cursor?.after ?? "0", $lte: through },
    }, { orderBy: { sequence: "asc" }, limit: limit + 1 });
    const visible = records.slice(0, limit);
    const items = visible.map(record => ({
      id: record.id, walletId: record.walletId, transactionId: record.transactionId,
      direction: record.direction, money: { amount: record.amount, currency: record.currency },
      balanceBefore: { amount: record.balanceBefore, currency: record.currency },
      balanceAfter: { amount: record.balanceAfter, currency: record.currency },
      createdAt: record.createdAt.toISOString(),
    }));
    return { items, nextCursor: records.length > limit ? encodeLedgerCursor({
      version: 1, walletId, after: visible[visible.length - 1]!.sequence, through,
    }) : null };
  }

  async reconcile(walletId: string): Promise<ReconciliationResult | null> {
    const rows = await this.em.execute<Array<{
      walletId: string; currency: string; stored: string; calculated: string;
      difference: string; consistent: boolean; checkedEntries: number;
    }>>(`SELECT w.id AS "walletId", w.currency, w.balance::text AS stored,
      coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00)::text AS calculated,
      (w.balance - coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00))::text AS difference,
      w.balance = coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0.00) AS consistent,
      count(l.id)::integer AS "checkedEntries"
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`, [walletId]);
    const row = rows[0];
    if (!row) return null;
    return { walletId: row.walletId, storedBalance: { amount: row.stored, currency: row.currency },
      calculatedBalance: { amount: row.calculated, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent, checkedEntries: row.checkedEntries };
  }

  async append(
    entry: WalletLedgerEntry,
    createdAt = new Date(),
  ): Promise<void> {
    const record = this.em.create(WalletLedgerEntrySchema, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      currency: entry.money.currency,
      amount: entry.money.toJSON().amount,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt,
    });
    this.em.persist(record);
    await this.em.flush();
  }
}
