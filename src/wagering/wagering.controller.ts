import { UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../auth/provider-auth.guard";
import {
  Body,
  Controller,
  Headers,
  HttpException,
  Inject,
  Post,
  Res,
  UseFilters,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ProcessTransaction, WagerRequestError } from "./process-transaction";
import { DatabaseHttpFilter } from "../database/database-http.filter";

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
      response.status(
        result.status === "FAILED"
          ? 500
          : result.status === "REJECTED"
            ? 422
            : result.status === "PENDING_REFERENCE"
              ? 202
              : 200,
      );
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
