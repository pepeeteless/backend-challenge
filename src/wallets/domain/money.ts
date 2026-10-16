import Decimal from "decimal.js";

const MoneyDecimal = Decimal.clone({ precision: 21 });
const MAX_AMOUNT = "999999999999999999.99";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new Error("Amount must be finite and within the supported range");
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== "string" ||
      !/^\d+\.\d{2}$/.test(props.amount)
    ) {
      throw new Error(
        "Amount must be a non-negative decimal string with exactly two decimal places",
      );
    }

    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error("Currency mismatch");
    }
  }
}
