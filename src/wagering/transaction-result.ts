import type { MoneyProps } from "../wallets/money";
import type { FailureCode } from "./wager-transaction";

export interface TransactionResult {
  transactionId: string;
  status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
