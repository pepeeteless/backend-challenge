import { Money } from "../wallets/money";
import { Wallet } from "../wallets/wallet";
import type { WalletLedgerEntry } from "../wallets/wallet-ledger-entry";

export type WagerTransactionStatus =
  | "PENDING"
  | "PENDING_REFERENCE"
  | "PROCESSED"
  | "REJECTED"
  | "FAILED";

export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "CURRENCY_MISMATCH"
  | "PLAYER_MISMATCH"
  | "INVALID_AMOUNT";

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return status === "PROCESSED" || status === "REJECTED" || status === "FAILED";
}

interface TransactionIdentity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "LOSS";
  money: Money;
}

interface TransactionState {
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  processedAt?: Date;
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
  get processedAt(): Date | undefined {
    return this.state.processedAt && new Date(this.state.processedAt);
  }

  isTerminal(): boolean {
    return isTerminalStatus(this.status);
  }

  applyBet(wallet: Wallet): WalletLedgerEntry | undefined {
    if (this.isTerminal()) {
      throw new Error("Transaction is already terminal");
    }
    if (this.status !== "PENDING") {
      throw new Error("BET must be pending");
    }
    if (wallet.id !== this.identity.walletId) {
      throw new Error("Wrong wallet loaded");
    }
    if (this.identity.kind !== "BET") {
      throw new Error("Expected BET transaction");
    }

    const money = this.identity.money;
    let failure: FailureCode | undefined;
    if (wallet.playerId !== this.identity.playerId) {
      failure = "PLAYER_MISMATCH";
    } else if (wallet.currency !== money.currency) {
      failure = "CURRENCY_MISMATCH";
    } else if (!money.isPositive()) {
      failure = "INVALID_AMOUNT";
    } else if (wallet.balance.isLessThan(money)) {
      failure = "INSUFFICIENT_FUNDS";
    }

    if (failure) {
      this.state = { status: "REJECTED", failureCode: failure };
      return undefined;
    }

    const entry = wallet.debit({
      entryId: crypto.randomUUID(),
      transactionId: this.identity.id,
      money,
    });
    this.state = { status: "PROCESSED", processedAt: new Date() };
    return entry;
  }

  applyLoss(wallet: Wallet): void {
    if (this.identity.kind !== "LOSS") {
      throw new Error("Expected LOSS transaction");
    }

    if (this.isTerminal()) {
      throw new Error("Transaction is already terminal");
    }

    if (this.status !== "PENDING") {
      throw new Error("LOSS mus be pending");
    }

    if (wallet.id !== this.identity.walletId) {
      throw new Error("Wrong wallet loaded");
    }

    if (wallet.playerId !== this.identity.playerId) {
      this.state = {
        status: "REJECTED",
        failureCode: "PLAYER_MISMATCH",
      };
      return;
    }

    if (wallet.currency !== this.identity.money.currency) {
      this.state = {
        status: "REJECTED",
        failureCode: "CURRENCY_MISMATCH",
      };
      return;
    }

    this.state = {
      status: "PROCESSED",
      processedAt: new Date(),
    };
  }
}
