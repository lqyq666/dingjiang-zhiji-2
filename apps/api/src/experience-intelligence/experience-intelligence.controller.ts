import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { ExperienceIntelligenceService } from "./experience-intelligence.service";

type Role = "PMC" | "EXPERT_REVIEWER";
const requireRole = (actual: string | undefined, expected: Role) => {
  if (actual !== expected)
    throw new HttpException(
      { code: "FORBIDDEN", message: "FORBIDDEN" },
      HttpStatus.FORBIDDEN,
    );
};

@Controller("vs17")
export class ExperienceIntelligenceController {
  constructor(
    @Inject(ExperienceIntelligenceService)
    private readonly service: ExperienceIntelligenceService,
  ) {}

  @Post("projects/:projectId/experience-drafts/ai")
  draft(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.call(() => this.service.draft(projectId, body));
  }

  @Post("experience-candidates/:candidateId/feishu/push")
  push(
    @Param("candidateId") candidateId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.call(() => this.service.push(candidateId, body));
  }

  @Post("feishu/reviews/pull")
  pull(
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.call(() => this.service.pull(body));
  }

  @Post("experiences/:experienceId/coze/publish")
  publish(
    @Param("experienceId") experienceId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.call(() => this.service.publish(experienceId, body));
  }

  @Post("experience-answer")
  answer(
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.call(() => this.service.answer(body));
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapError(error);
    }
  }
}

const mapError = (error: unknown): HttpException => {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === "string"
        ? response
        : String((response as { message?: unknown }).message ?? "");
    const status = codeStatus(message);
    return status
      ? new HttpException({ code: message, message }, status)
      : error;
  }
  const message = error instanceof Error ? error.message : "PROVIDER_FAILED";
  return new HttpException(
    { code: message, message },
    codeStatus(message) ?? HttpStatus.BAD_GATEWAY,
  );
};
const codeStatus = (message: string): number | null => {
  if (message.includes("FORBIDDEN") || message.includes("SCOPE_VIOLATION"))
    return HttpStatus.FORBIDDEN;
  if (message.includes("NOT_FOUND")) return HttpStatus.NOT_FOUND;
  if (
    message.includes("INVALID_PROVIDER_OUTPUT") ||
    message.includes("INVALID_REVIEW")
  )
    return HttpStatus.UNPROCESSABLE_ENTITY;
  if (message.includes("PROVIDER_TIMEOUT")) return HttpStatus.GATEWAY_TIMEOUT;
  if (message.includes("PROVIDER_FAILED") || message.includes("INDEX_FAILED"))
    return HttpStatus.BAD_GATEWAY;
  if (
    message.includes("STALE_CANDIDATE") ||
    message.includes("FORMAL_EXPERIENCE_REQUIRED") ||
    message.includes("REQUEST_ID_REUSED")
  )
    return HttpStatus.CONFLICT;
  return null;
};
