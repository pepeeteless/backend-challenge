import type { MoneyProps } from "../../wallets/domain/money";
import type { FailureCode } from "../domain/wager-transaction";

export interface TransactionResult {
  transactionId: string;
  status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
