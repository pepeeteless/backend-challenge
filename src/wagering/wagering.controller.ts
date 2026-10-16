import {
  Body, Controller, Headers, HttpException, Inject, Post, Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ProcessBet, WagerRequestError } from "./process-bet";

@Controller("wagering/transactions")
export class WageringController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    try {
      const result = await new ProcessBet(this.database.createEntityManager()).execute(body, key);
      response.status(result.status === "REJECTED" ? 422 : 200);
      return result;
    } catch (error) {
      if (error instanceof WagerRequestError) {
        throw new HttpException({ code: error.code, message: error.message }, error.httpStatus);
      }
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/^(08|53|57)/.test(code)
        || ["40001", "40P01", "55P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
        throw new ServiceUnavailableException({
          code: "TEMPORARY_UNAVAILABLE", message: "Retry with the same idempotency key",
        });
      }
      throw error;
    }
  }
}
