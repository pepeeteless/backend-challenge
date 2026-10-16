import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../wallets/money";
import { Wallet } from "../wallets/wallet";
import { WalletRepository } from "../wallets/wallet.repository";
import { LedgerRepository } from "../wallets/ledger.repository";
import {
  transactionInputSchema,
  hashTransactionPayload,
  idempotencyKeySchema,
} from "./transaction-input";
import { WagerTransaction } from "./wager-transaction";
import {
  WagerTransactionRepository,
  type StoredTransaction,
} from "./wager-transaction.repository";
import type { TransactionResult } from "./transaction-result";
import {
  nextReferenceAttempt,
  REFERENCE_MAX_ATTEMPTS,
} from "./reference-retry-policy";
import {
  MessageRepository,
  type MessageContext,
} from "../messaging/message.repository";
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WagerTransactionFailed,
} from "../messaging/integration-event";
import { operationalMetrics } from "../observability/metrics";
import { errorCode, logEvent } from "../observability/logger";

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
    return this.executeTransaction(body, key, message, true);
  }

  private async executeTransaction(
    body: unknown,
    key: unknown,
    message?: MessageContext,
    exhausted = false,
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
      const complete = async (result: TransactionResult) => {
        if (message) await messages.complete(message, result);
        return result;
      };
      const wallets = new WalletRepository(em);
      const transactions = new WagerTransactionRepository(em);
      const findExisting = () =>
        transactions.findExisting(
          idempotencyKey,
          input.providerId,
          input.externalTransactionId,
        );
      const existing = await findExisting();
      if (existing.length)
        return complete(this.replay(existing, idempotencyKey, payloadHash));

      const wallet = await wallets.findForUpdate(input.walletId);
      if (!wallet) throw new WagerRequestError("WALLET_NOT_FOUND", 404);
      const transaction = WagerTransaction.create({
        ...input,
        id: crypto.randomUUID(),
        idempotencyKey,
        payloadHash,
        money: Money.from(input.money),
      });
      if (!(await transactions.tryInsertPending(transaction))) {
        return complete(
          this.replay(await findExisting(), idempotencyKey, payloadHash),
        );
      }
      if (exhausted) {
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
        return complete(result);
      }
      return complete(
        await this.applyAndSave(
          em,
          wallet,
          transaction,
          0,
          new Date(),
          message?.messageId,
        ),
      );
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
      if (
        !current ||
        current.status !== "PENDING_REFERENCE" ||
        !current.nextReferenceAttemptAt ||
        current.nextReferenceAttemptAt > now
      )
        return null;

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
    const reference = identity.referenceExternalTransactionId
      ? await transactions.findReference(
          identity.providerId,
          identity.referenceExternalTransactionId,
        )
      : undefined;
    const alreadyReversed =
      reference && (identity.kind === "REFUND" || identity.kind === "ROLLBACK")
        ? await transactions.hasProcessedReversal(reference.id, identity.kind)
        : false;
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
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
      idempotentReplay: false,
    };
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
    const data = {
      transactionId: identity.id,
      walletId: wallet.id,
      kind: identity.kind,
      status,
      money: identity.money.toJSON(),
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
    };
    if (status === "PROCESSED")
      await messages.enqueue(WagerTransactionProcessed.create(data, context));
    if (status === "REJECTED")
      await messages.enqueue(WagerTransactionRejected.create(data, context));
    if (status === "PENDING_REFERENCE" && attempts === 1) {
      await messages.enqueue(
        WagerTransactionPendingReference.create(data, context),
      );
    }
    if (entry)
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
    return result;
  }

  private replay(
    rows: StoredTransaction[],
    idempotencyKey: string,
    payloadHash: string,
  ): TransactionResult {
    if (
      rows.length !== 1 ||
      rows[0].idempotencyKey !== idempotencyKey ||
      rows[0].payloadHash !== payloadHash
    ) {
      throw new WagerRequestError("IDEMPOTENCY_CONFLICT", 409);
    }
    if (!rows[0].response)
      throw new Error("Committed transaction has no response");
    return { ...rows[0].response, idempotentReplay: true };
  }
}
