import { Money } from "../../wallets/domain/money";
import { Wallet } from "../../wallets/domain/wallet";
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../wallets/domain/wallet-ledger-entry";

export type WagerTransactionKind =
  | "BET"
  | "WIN"
  | "LOSS"
  | "REFUND"
  | "ROLLBACK";
export type WagerTransactionStatus =
  | "PENDING"
  | "PENDING_REFERENCE"
  | "PROCESSED"
  | "REJECTED"
  | "FAILED";
export type FailureCode =
  | "INFRASTRUCTURE_RETRY_EXHAUSTED"
  | "INSUFFICIENT_FUNDS"
  | "CURRENCY_MISMATCH"
  | "PLAYER_MISMATCH"
  | "INVALID_AMOUNT"
  | "BALANCE_LIMIT_EXCEEDED"
  | "REFERENCE_MISMATCH"
  | "REFERENCE_KIND_INVALID"
  | "REFERENCE_NOT_PROCESSED"
  | "REFERENCE_AMOUNT_MISMATCH"
  | "REFERENCE_ALREADY_REVERSED"
  | "REVERSAL_INSUFFICIENT_FUNDS"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_NOT_READY";

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return status === "PROCESSED" || status === "REJECTED" || status === "FAILED";
}

export interface TransactionIdentity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

interface TransactionState {
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceTransactionId?: string;
}

export interface TransactionReference {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind | "OPENING";
  status: WagerTransactionStatus;
  money: Money;
}

export class WagerTransaction {
  private constructor(
    public readonly identity: Readonly<TransactionIdentity>,
    private state: TransactionState,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.state = {
      ...state,
      processedAt: state.processedAt && new Date(state.processedAt),
    };
  }

  static create(identity: TransactionIdentity): WagerTransaction {
    const requiresReference =
      identity.kind === "REFUND" || identity.kind === "ROLLBACK";
    if (requiresReference && !identity.referenceExternalTransactionId) {
      throw new Error("Reference is required");
    }
    if (
      identity.referenceExternalTransactionId &&
      (identity.kind === "BET" || identity.kind === "LOSS")
    ) {
      throw new Error("Reference is not supported for this kind");
    }
    if (
      identity.referenceExternalTransactionId === identity.externalTransactionId
    ) {
      throw new Error("Transaction cannot reference itself");
    }
    return new WagerTransaction(identity, { status: "PENDING" });
  }

  static rehydrate(
    identity: TransactionIdentity,
    state: TransactionState,
  ): WagerTransaction {
    return new WagerTransaction(identity, state);
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }
  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }
  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }
  get processedAt(): Date | undefined {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  isTerminal(): boolean {
    return isTerminalStatus(this.status);
  }
  isReversal(): boolean {
    return this.identity.kind === "REFUND" || this.identity.kind === "ROLLBACK";
  }

  reject(code: FailureCode): undefined {
    this.assertMutable();
    this.state = {
      status: "REJECTED",
      failureCode: code,
      referenceTransactionId: this.referenceTransactionId,
    };
  }

  fail(code: "INFRASTRUCTURE_RETRY_EXHAUSTED"): void {
    this.assertMutable();
    this.state = {
      status: "FAILED",
      failureCode: code,
      referenceTransactionId: this.referenceTransactionId,
    };
  }

  apply(
    wallet: Wallet,
    reference?: TransactionReference,
    alreadyReversed = false,
    now = new Date(),
  ): WalletLedgerEntry | undefined {
    this.assertMutable();
    if (wallet.id !== this.identity.walletId)
      throw new Error("Wrong wallet loaded");
    if (wallet.playerId !== this.identity.playerId)
      return this.reject("PLAYER_MISMATCH");
    if (wallet.currency !== this.identity.money.currency)
      return this.reject("CURRENCY_MISMATCH");
    if (this.identity.kind !== "LOSS" && !this.identity.money.isPositive())
      return this.reject("INVALID_AMOUNT");

    if (this.identity.referenceExternalTransactionId) {
      if (!reference) {
        this.state = { status: "PENDING_REFERENCE" };
        return;
      }
      this.state.referenceTransactionId = reference.id;
      if (
        reference.providerId !== this.identity.providerId ||
        reference.externalTransactionId !==
          this.identity.referenceExternalTransactionId ||
        reference.walletId !== wallet.id ||
        reference.playerId !== wallet.playerId ||
        reference.money.currency !== wallet.currency ||
        reference.roundId !== this.identity.roundId
      ) {
        return this.reject("REFERENCE_MISMATCH");
      }
      const validKind =
        this.identity.kind === "ROLLBACK"
          ? ["BET", "WIN", "REFUND"].includes(reference.kind)
          : reference.kind === "BET";
      if (!validKind) return this.reject("REFERENCE_KIND_INVALID");
      if (this.isReversal() && !reference.money.equals(this.identity.money)) {
        return this.reject("REFERENCE_AMOUNT_MISMATCH");
      }
      if (!isTerminalStatus(reference.status)) {
        this.state.status = "PENDING_REFERENCE";
        return;
      }
      if (reference.status !== "PROCESSED")
        return this.reject("REFERENCE_NOT_PROCESSED");
      if (this.isReversal() && alreadyReversed)
        return this.reject("REFERENCE_ALREADY_REVERSED");
    }

    if (this.identity.kind === "LOSS") {
      this.markProcessed(now);
      return;
    }
    let direction: LedgerDirection = "CREDIT";
    if (this.identity.kind === "BET") {
      direction = "DEBIT";
    } else if (this.identity.kind === "ROLLBACK" && reference?.kind !== "BET") {
      direction = "DEBIT";
    }
    if (
      direction === "DEBIT" &&
      wallet.balance.isLessThan(this.identity.money)
    ) {
      if (this.isReversal()) {
        return this.reject("REVERSAL_INSUFFICIENT_FUNDS");
      }
      return this.reject("INSUFFICIENT_FUNDS");
    }
    if (direction === "CREDIT") {
      const limit = Money.from({
        amount: "999999999999999999.99",
        currency: wallet.currency,
      });
      if (limit.subtract(wallet.balance).isLessThan(this.identity.money)) {
        return this.reject("BALANCE_LIMIT_EXCEEDED");
      }
    }
    const props = {
      entryId: crypto.randomUUID(),
      transactionId: this.identity.id,
      money: this.identity.money,
    };
    const entry =
      direction === "DEBIT" ? wallet.debit(props) : wallet.credit(props);
    this.markProcessed(now);
    return entry;
  }

  applyBet(wallet: Wallet): WalletLedgerEntry | undefined {
    if (this.identity.kind !== "BET")
      throw new Error("Expected BET transaction");
    return this.apply(wallet);
  }
  applyWin(wallet: Wallet): WalletLedgerEntry | undefined {
    if (this.identity.kind !== "WIN")
      throw new Error("Expected WIN transaction");
    return this.apply(wallet);
  }
  applyLoss(wallet: Wallet): void {
    if (this.identity.kind !== "LOSS")
      throw new Error("Expected LOSS transaction");
    this.apply(wallet);
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new Error("Transaction is already terminal");
  }
  private markProcessed(at: Date): void {
    this.state = {
      status: "PROCESSED",
      processedAt: new Date(at),
      referenceTransactionId: this.referenceTransactionId,
    };
  }
}
