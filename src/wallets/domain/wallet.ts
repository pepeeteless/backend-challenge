import { Money } from "./money";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {
    this._createdAt = new Date(_createdAt.getTime());
    this._updatedAt = new Date(_updatedAt.getTime());
  }

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new Error("Initial balance cannot be negative");
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(props: {
    entryId: string;
    transactionId: string;
    money: Money;
  }): WalletLedgerEntry {
    if (props.money.currency !== this.currency) {
      throw new Error("Currency mismatch");
    }

    if (!props.money.isPositive()) {
      throw new Error("Debit amount must be positive");
    }

    if (this._balance.isLessThan(props.money)) {
      throw new Error("Insufficient funds");
    }

    const nextBalance = this._balance.subtract(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: "DEBIT",
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: nextBalance,
    });

    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = new Date();

    return entry;
  }

  credit(props: {
    entryId: string;
    transactionId: string;
    money: Money;
  }): WalletLedgerEntry {
    if (props.money.currency !== this.currency) {
      throw new Error("Currency mismatch");
    }

    if (!props.money.isPositive()) {
      throw new Error("Credit amount must be positive");
    }

    const nextBalance = this._balance.add(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: "CREDIT",
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: nextBalance,
    });

    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = new Date();

    return entry;
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }
}
