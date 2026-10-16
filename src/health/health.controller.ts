import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ReadinessService } from "./readiness.service";

@Controller("health")
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}
  @Get("ready")
  async ready() {
    const result = await this.readiness.check();
    if (result.status !== "ok") throw new ServiceUnavailableException(result);
    return result;
  }
  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }
}
