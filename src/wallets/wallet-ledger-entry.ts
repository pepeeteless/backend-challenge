import { Money } from "./money";

export type LedgerDirection = "DEBIT" | "CREDIT";

interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (
      props.money.isNegative() ||
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new Error("Ledger Entry can't negative values.");
    }

    if (props.direction !== "DEBIT" && props.direction !== "CREDIT") {
      throw new Error("Invalid ledger entry direction");
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
    );

    if (!entry.isBalanced()) {
      throw new Error("Invalid Ledger entry");
    }

    return entry;
  }

  isBalanced(): boolean {
    const expected =
      this.direction === "DEBIT"
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
