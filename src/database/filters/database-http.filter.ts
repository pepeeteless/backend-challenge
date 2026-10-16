import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { logEvent, errorCode } from "../../observability/logger";
import { operationalMetrics } from "../../observability/metrics";

@Catch()
export class DatabaseHttpFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(body: unknown): void } }>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    const code = errorCode(error);
    operationalMetrics.databaseError(error);
    const transient =
      /^(08|53|57)/.test(code) ||
      [
        "40001",
        "40P01",
        "55P03",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
      ].includes(code);
    logEvent("http_database_failure", { code }, "error");
    response.status(transient ? 503 : 500).json({
      code: transient ? "TEMPORARY_UNAVAILABLE" : "INTERNAL_ERROR",
      message: transient
        ? "Retry later; reuse the same idempotency key when submitting a transaction"
        : "Internal server error",
    });
  }
}
