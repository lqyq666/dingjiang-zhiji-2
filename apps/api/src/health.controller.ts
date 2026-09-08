import {
  healthResponseSchema,
  type HealthResponse,
} from "@dingjiang/contracts";
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check(): HealthResponse {
    return healthResponseSchema.parse({
      service: "api",
      status: "ok",
    });
  }
}
