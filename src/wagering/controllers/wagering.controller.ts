import { ProviderAuthGuard } from "../../auth/provider-auth.guard";
import {
  Body,
  Controller,
  Headers,
  HttpException,
  Inject,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import { ProcessTransaction, WagerRequestError } from "../use-cases/process-transaction";
import { DatabaseHttpFilter } from "../../database/filters/database-http.filter";
import type { TransactionResult } from "../contracts/transaction-result";

const httpStatusByResult: Record<TransactionResult["status"], number> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
  FAILED: 500,
};

@Controller("wagering/transactions")
@UseFilters(DatabaseHttpFilter)
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    try {
      const result = await new ProcessTransaction(
        this.database.createEntityManager(),
      ).execute(body, key);
      response.status(httpStatusByResult[result.status]);
      return result;
    } catch (error) {
      if (error instanceof WagerRequestError) {
        throw new HttpException(
          { code: error.code, message: error.message },
          error.httpStatus,
        );
      }
      throw error;
    }
  }
}
