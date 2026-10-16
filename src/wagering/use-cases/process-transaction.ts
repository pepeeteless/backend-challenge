import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../wallets/domain/money";
import { Wallet } from "../../wallets/domain/wallet";
import { WalletRepository } from "../../wallets/repositories/wallet.repository";
import { LedgerRepository } from "../../wallets/repositories/ledger.repository";
import {
  transactionInputSchema,
  hashTransactionPayload,
  idempotencyKeySchema,
} from "../contracts/transaction-input";
import { WagerTransaction, type TransactionReference } from "../domain/wager-transaction";
import {
  WagerTransactionRepository,
  type StoredTransaction,
} from "../repositories/wager-transaction.repository";
import type { TransactionResult } from "../contracts/transaction-result";
import {
  nextReferenceAttempt,
  REFERENCE_MAX_ATTEMPTS,
} from "./reference-retry-policy";
import {
  MessageRepository,
  type MessageContext,
} from "../../messaging/repositories/message.repository";
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WagerTransactionFailed,
  type TransactionEventData,
} from "../../messaging/events/integration-event";
import { operationalMetrics } from "../../observability/metrics";
import { errorCode, logEvent } from "../../observability/logger";

export class WagerRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: 400 | 404 | 409,
  ) {
    super(code);
  }
}

export class ProcessTransaction {
  constructor(private readonly em: EntityManager) {}

  async execute(
    body: unknown,
    key: unknown,
    message?: MessageContext,
  ): Promise<TransactionResult> {
    const start = performance.now();
    const parsed = transactionInputSchema.safeParse(body);
    const fields = {
      messageId: message?.messageId,
      walletId: parsed.success ? parsed.data.walletId : undefined,
      providerId: parsed.success ? parsed.data.providerId : undefined,
    };
    try {
      const result = await this.executeTransaction(body, key, message);
      if (result.idempotentReplay) operationalMetrics.duplicates += 1;
      logEvent("transaction_completed", {
        ...fields,
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      operationalMetrics.databaseError(error);
      logEvent(
        "transaction_failed",
        { ...fields, code: errorCode(error) },
        "error",
      );
      throw error;
    } finally {
      operationalMetrics.observe(
        message ? "sqs" : "http",
        (performance.now() - start) / 1000,
      );
    }
  }

  async recordFailure(
    body: unknown,
    key: unknown,
    message: MessageContext,
  ): Promise<TransactionResult> {
    return this.executeTransaction(body, key, message, "record-failure");
  }

  private async executeTransaction(
    body: unknown,
    key: unknown,
    message?: MessageContext,
    action: "process" | "record-failure" = "process",
  ): Promise<TransactionResult> {
    const parsed = transactionInputSchema.safeParse(body);
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsed.success || !parsedKey.success)
      throw new WagerRequestError("INVALID_PAYLOAD", 400);
    const input = parsed.data;
    const idempotencyKey = parsedKey.data;
    const payloadHash = hashTransactionPayload(input);

    return this.em.transactional(async (em) => {
      const messages = new MessageRepository(em);
      if (message) {
        const replay = await messages.receive(
          message,
          payloadHash,
          idempotencyKey,
        );
        if (replay) return replay;
      }
      const completeInbox = async (result: TransactionResult) => {
        if (message) await messages.complete(message, result);
        return result;
      };
      const wallets = new WalletRepository(em);
      const transactions = new WagerTransactionRepository(em);
      const findExistingTransaction = () =>
        transactions.findExisting(
          idempotencyKey,
          input.providerId,
          input.externalTransactionId,
        );
      const existing = await findExistingTransaction();
      if (existing.length)
        return completeInbox(this.replay(existing, idempotencyKey, payloadHash));

      const wallet = await wallets.findForUpdate(input.walletId);
      if (!wallet) throw new WagerRequestError("WALLET_NOT_FOUND", 404);
      const transaction = WagerTransaction.create({
        ...input,
        id: crypto.randomUUID(),
        idempotencyKey,
        payloadHash,
        money: Money.from(input.money),
      });
      const inserted = await transactions.tryInsertPending(transaction);
      if (!inserted) {
        const existingTransaction = await findExistingTransaction();
        return completeInbox(
          this.replay(existingTransaction, idempotencyKey, payloadHash),
        );
      }
      if (action === "record-failure") {
        transaction.fail("INFRASTRUCTURE_RETRY_EXHAUSTED");
        const result: TransactionResult = {
          transactionId: transaction.identity.id,
          status: "FAILED",
          balance: wallet.balance.toJSON(),
          failureCode: transaction.failureCode,
          idempotentReplay: false,
        };
        await transactions.saveOutcome(transaction, result, 0, null);
        await messages.enqueue(
          WagerTransactionFailed.create(
            {
              transactionId: transaction.identity.id,
              walletId: wallet.id,
              kind: input.kind,
              status: "FAILED",
              money: input.money,
              failureCode: transaction.failureCode,
            },
            {
              aggregateId: wallet.id,
              correlationId: transaction.identity.id,
              causationId: message?.messageId,
              occurredAt: new Date(),
            },
          ),
        );
        return completeInbox(result);
      }
      const result = await this.applyAndSave(
        em,
        wallet,
        transaction,
        0,
        new Date(),
        message?.messageId,
      );
      return completeInbox(result);
    });
  }

  async retryPending(
    id: string,
    now = new Date(),
  ): Promise<TransactionResult | null> {
    const start = performance.now();
    operationalMetrics.retry("reference");
    try {
      const result = await this.retryTransaction(id, now);
      if (result)
        logEvent("reference_retry_completed", {
          transactionId: id,
          status: result.status,
        });
      return result;
    } catch (error) {
      operationalMetrics.databaseError(error);
      throw error;
    } finally {
      operationalMetrics.observe(
        "reference",
        (performance.now() - start) / 1000,
      );
    }
  }

  private async retryTransaction(
    id: string,
    now: Date,
  ): Promise<TransactionResult | null> {
    return this.em.transactional(async (em) => {
      const transactions = new WagerTransactionRepository(em);
      const candidate = await transactions.findById(id);
      if (!candidate || candidate.status !== "PENDING_REFERENCE") return null;

      const wallet = await new WalletRepository(em).findForUpdate(
        candidate.walletId,
      );
      if (!wallet) throw new Error("Pending transaction wallet is missing");
      const current = await transactions.findById(id);
      if (!current || current.status !== "PENDING_REFERENCE") return null;
      const nextAttemptAt = current.nextReferenceAttemptAt;
      if (!nextAttemptAt || nextAttemptAt > now) return null;

      return this.applyAndSave(
        em,
        wallet,
        transactions.rehydrate(current),
        current.referenceAttempts,
        now,
      );
    });
  }

  private async applyAndSave(
    em: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
    attempts: number,
    now: Date,
    causationId?: string,
  ): Promise<TransactionResult> {
    const transactions = new WagerTransactionRepository(em);
    const identity = transaction.identity;
    let reference: TransactionReference | undefined;
    if (identity.referenceExternalTransactionId) {
      reference = await transactions.findReference(
        identity.providerId,
        identity.referenceExternalTransactionId,
      );
    }

    let alreadyReversed = false;
    if (reference && (identity.kind === "REFUND" || identity.kind === "ROLLBACK")) {
      alreadyReversed = await transactions.hasProcessedReversal(reference.id, identity.kind);
    }
    const entry = transaction.apply(wallet, reference, alreadyReversed, now);

    let nextAttemptAt: Date | null = null;
    if (transaction.status === "PENDING_REFERENCE") {
      attempts += 1;
      if (attempts >= REFERENCE_MAX_ATTEMPTS) {
        transaction.reject(
          reference ? "REFERENCE_NOT_READY" : "REFERENCE_NOT_FOUND",
        );
      } else {
        nextAttemptAt = nextReferenceAttempt(now, attempts);
      }
    }
    if (entry) {
      await new WalletRepository(em).save(wallet);
      await new LedgerRepository(em).append(entry, now);
    }
    const status = transaction.status;
    if (
      status !== "PROCESSED" &&
      status !== "REJECTED" &&
      status !== "PENDING_REFERENCE"
    ) {
      throw new Error("Expected an outcome after processing");
    }
    const result: TransactionResult = {
      transactionId: identity.id,
      status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
    if (transaction.failureCode) {
      result.failureCode = transaction.failureCode;
    }
    await transactions.saveOutcome(
      transaction,
      result,
      attempts,
      nextAttemptAt,
    );
    const messages = new MessageRepository(em);
    const context = {
      aggregateId: wallet.id,
      correlationId: identity.id,
      causationId,
      occurredAt: now,
    };
    const eventData: TransactionEventData = {
      transactionId: identity.id,
      walletId: wallet.id,
      kind: identity.kind,
      status,
      money: identity.money.toJSON(),
    };
    if (transaction.failureCode) {
      eventData.failureCode = transaction.failureCode;
    }

    if (status === "PROCESSED") {
      await messages.enqueue(WagerTransactionProcessed.create(eventData, context));
    } else if (status === "REJECTED") {
      await messages.enqueue(WagerTransactionRejected.create(eventData, context));
    } else if (status === "PENDING_REFERENCE" && attempts === 1) {
      await messages.enqueue(
        WagerTransactionPendingReference.create(eventData, context),
      );
    }
    if (entry) {
      await messages.enqueue(
        WalletBalanceChanged.create(
          {
            walletId: wallet.id,
            transactionId: identity.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
          context,
        ),
      );
    }
    return result;
  }

  private replay(
    rows: StoredTransaction[],
    idempotencyKey: string,
    payloadHash: string,
  ): TransactionResult {
    const existing = rows[0];
    if (
      rows.length !== 1 ||
      !existing ||
      existing.idempotencyKey !== idempotencyKey ||
      existing.payloadHash !== payloadHash
    ) {
      throw new WagerRequestError("IDEMPOTENCY_CONFLICT", 409);
    }
    if (!existing.response)
      throw new Error("Committed transaction has no response");
    return { ...existing.response, idempotentReplay: true };
  }
}
