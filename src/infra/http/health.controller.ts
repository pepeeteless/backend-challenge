import { Controller, Get } from "@nestjs/common";

@Controller("Health")
export class HealthController {
  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }
}
