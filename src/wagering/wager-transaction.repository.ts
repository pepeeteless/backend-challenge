import { EntityManager } from "@mikro-orm/postgresql";
import { Wallet } from "../wallets/wallet";
import { WagerTransaction, type FailureCode, type TransactionReference } from "./wager-transaction";
import { Money } from "../wallets/money";
import {
  WagerTransactionSchema,
  type WagerTransactionRecord,
} from "./wager-transaction.schema";
import type { TransactionResult } from "./transaction-result";

export type StoredTransaction = Pick<
  WagerTransactionRecord,
  "idempotencyKey" | "payloadHash" | "response"
>;

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findExisting(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredTransaction[]> {
    return this.em.find(
      WagerTransactionSchema,
      {
        $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
      },
      { fields: ["idempotencyKey", "payloadHash", "response"], refresh: true },
    );
  }

  async tryInsertPending(transaction: WagerTransaction): Promise<boolean> {
    const identity = transaction.identity;
    const rows = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert({
        id: identity.id,
        walletId: identity.walletId,
        currency: identity.money.currency,
        amount: identity.money.toJSON().amount,
        kind: identity.kind,
        status: "PENDING",
        createdAt: new Date(),
        processedAt: null,
        providerId: identity.providerId,
        externalTransactionId: identity.externalTransactionId,
        idempotencyKey: identity.idempotencyKey,
        payloadHash: identity.payloadHash,
        playerId: identity.playerId,
        roundId: identity.roundId,
        gameId: identity.gameId,
        failureCode: null,
        response: null,
        referenceExternalTransactionId: identity.referenceExternalTransactionId ?? null,
        referenceTransactionId: null,
        referenceAttempts: 0,
        nextReferenceAttemptAt: null,
      })
      .onConflict()
      .ignore()
      .returning(["id"])
      .execute("all");
    return rows.length > 0;
  }

  async saveOutcome(
    transaction: WagerTransaction,
    result: TransactionResult,
    referenceAttempts: number,
    nextReferenceAttemptAt: Date | null,
  ): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionSchema, {
      id: transaction.identity.id,
    });
    record.status = result.status;
    record.failureCode = transaction.failureCode ?? null;
    record.processedAt = transaction.processedAt ?? null;
    record.response = result;
    record.referenceTransactionId = transaction.referenceTransactionId ?? null;
    record.referenceAttempts = referenceAttempts;
    record.nextReferenceAttemptAt = nextReferenceAttemptAt;
    await this.em.flush();
  }

  async insertOpening(id: string, wallet: Wallet): Promise<void> {
    const record = this.em.create(WagerTransactionSchema, {
      id,
      walletId: wallet.id,
      currency: wallet.currency,
      amount: wallet.balance.toJSON().amount,
      kind: "OPENING",
      status: "PROCESSED",
      createdAt: wallet.createdAt,
      processedAt: wallet.createdAt,
      providerId: null,
      externalTransactionId: null,
      idempotencyKey: null,
      payloadHash: null,
      playerId: null,
      roundId: null,
      gameId: null,
      failureCode: null,
      response: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      referenceAttempts: 0,
      nextReferenceAttemptAt: null,
    });
    this.em.persist(record);
    await this.em.flush();
  }

  findById(id: string): Promise<WagerTransactionRecord | null> {
    return this.em.findOne(WagerTransactionSchema, { id }, { refresh: true });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionRecord | null> {
    return this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }, { refresh: true });
  }

  async findReference(providerId: string, externalTransactionId: string): Promise<TransactionReference | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, {
      providerId, externalTransactionId,
    }, { refresh: true });
    if (!record) return undefined;
    if (!record.providerId || !record.externalTransactionId || !record.playerId || !record.roundId) {
      throw new Error("External transaction has incomplete identity");
    }
    return {
      id: record.id, providerId: record.providerId, externalTransactionId: record.externalTransactionId,
      walletId: record.walletId, playerId: record.playerId, roundId: record.roundId,
      kind: record.kind, status: record.status,
      money: Money.from({ amount: record.amount, currency: record.currency }),
    };
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: "REFUND" | "ROLLBACK"): Promise<boolean> {
    return await this.em.count(WagerTransactionSchema, {
      referenceTransactionId, kind, status: "PROCESSED",
    }) > 0;
  }

  findDue(now: Date, limit = 25) {
    return this.em.find(WagerTransactionSchema, {
      status: "PENDING_REFERENCE", nextReferenceAttemptAt: { $lte: now },
    }, { fields: ["id"], orderBy: { nextReferenceAttemptAt: "asc", id: "asc" }, limit });
  }

  rehydrate(record: WagerTransactionRecord): WagerTransaction {
    if (record.kind === "OPENING" || !record.providerId || !record.externalTransactionId
      || !record.idempotencyKey || !record.payloadHash || !record.playerId || !record.roundId || !record.gameId) {
      throw new Error("Cannot retry an internal or incomplete transaction");
    }
    return WagerTransaction.rehydrate({
      id: record.id, walletId: record.walletId, providerId: record.providerId,
      externalTransactionId: record.externalTransactionId, idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash, playerId: record.playerId, roundId: record.roundId,
      gameId: record.gameId, kind: record.kind,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    }, {
      status: record.status, failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: record.processedAt ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
    });
  }
}
