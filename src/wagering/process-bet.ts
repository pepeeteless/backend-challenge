import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../wallets/money";
import { Wallet } from "../wallets/wallet";
import { WalletSchema } from "../wallets/wallet.schema";
import { betInputSchema, hashBetPayload, idempotencyKeySchema } from "./bet-input";
import { WagerTransaction, type FailureCode } from "./wager-transaction";

export interface BetResult {
  transactionId: string;
  status: "PROCESSED" | "REJECTED";
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class WagerRequestError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: 400 | 404 | 409) {
    super(code);
  }
}

interface StoredRequest {
  idempotency_key: string;
  payload_hash: string;
  response: BetResult | null;
}

export class ProcessBet {
  constructor(private readonly em: EntityManager) {}

  async execute(body: unknown, key: unknown): Promise<BetResult> {
    const parsed = betInputSchema.safeParse(body);
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsed.success || !parsedKey.success) {
      throw new WagerRequestError("INVALID_PAYLOAD", 400);
    }
    const input = parsed.data;
    const idempotencyKey = parsedKey.data;
    const payloadHash = hashBetPayload(input);

    return this.em.transactional(async (em) => {
      await em.execute("SET LOCAL lock_timeout = '5s'");

      // A identidade externa tambem e unica: trocar a chave nao permite cobrar de novo.
      const findExisting = () => em.execute<StoredRequest[]>(`
        SELECT idempotency_key, payload_hash, response FROM wager_transactions
        WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)
      `, [idempotencyKey, input.providerId, input.externalTransactionId]);

      const replay = (rows: StoredRequest[]): BetResult => {
        if (rows.length !== 1 || rows[0].idempotency_key !== idempotencyKey
          || rows[0].payload_hash !== payloadHash) {
          throw new WagerRequestError("IDEMPOTENCY_CONFLICT", 409);
        }
        if (!rows[0].response) throw new Error("Committed BET has no response");
        return { ...rows[0].response, idempotentReplay: true };
      };

      const existing = await findExisting();
      if (existing.length) return replay(existing);

      // SELECT FOR UPDATE: apenas esta carteira fica bloqueada ate commit/rollback.
      const record = await em.findOne(WalletSchema, { id: input.walletId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      });
      if (!record) throw new WagerRequestError("WALLET_NOT_FOUND", 404);

      const transaction = WagerTransaction.create({
        ...input, id: crypto.randomUUID(), idempotencyKey, payloadHash,
        money: Money.from(input.money),
      });

      // A constraint do PostgreSQL arbitra duplicatas entre conexoes/processos.
      // ON CONFLICT espera a outra transacao terminar sem abortar esta transacao SQL.
      const inserted = await em.execute<{ id: string }[]>(`
        INSERT INTO wager_transactions (
          id, wallet_id, currency, amount, kind, status, provider_id,
          external_transaction_id, idempotency_key, payload_hash, player_id, round_id, game_id
        ) VALUES (?, ?, ?, ?, 'BET', 'PENDING', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING RETURNING id
      `, [transaction.identity.id, input.walletId, input.money.currency, input.money.amount,
        input.providerId, input.externalTransactionId, idempotencyKey, payloadHash,
        input.playerId, input.roundId, input.gameId]);
      if (!inserted.length) return replay(await findExisting());

      const wallet = Wallet.rehydrate({
        ...record,
        balance: Money.from({ amount: record.balance, currency: record.currency }),
      });
      const entry = transaction.applyBet(wallet);

      if (entry) {
        record.balance = wallet.balance.toJSON().amount;
        record.version = wallet.version;
        record.updatedAt = wallet.updatedAt;
        await em.flush();
        await em.execute(`
          INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, currency, amount,
            balance_before, balance_after
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [entry.id, entry.walletId, entry.transactionId, entry.direction,
          entry.money.currency, entry.money.toJSON().amount,
          entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount]);
      }

      const result: BetResult = {
        transactionId: transaction.identity.id,
        status: entry ? "PROCESSED" : "REJECTED",
        balance: wallet.balance.toJSON(),
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
        idempotentReplay: false,
      };
      await em.execute(`
        UPDATE wager_transactions SET status = ?, failure_code = ?, processed_at = ?, response = ?::jsonb
        WHERE id = ?
      `, [result.status, transaction.failureCode ?? null, transaction.processedAt ?? null,
        JSON.stringify(result), result.transactionId]);

      // transactional so entrega este resultado ao chamador depois do commit.
      return result;
    });
  }
}
