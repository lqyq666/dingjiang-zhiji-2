import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { TaskOrchestrationService } from "./task-orchestration.service";

const requireRole = (actual: string | undefined, expected: "PMC" | "OWNER") => {
  if (actual !== expected)
    throw new ForbiddenException("当前角色无权执行此操作");
};

@Controller("vs18")
export class TaskOrchestrationController {
  constructor(
    @Inject(TaskOrchestrationService)
    private readonly service: TaskOrchestrationService,
  ) {}

  @Get("projects/:projectId/phases/:phaseCode/task-proposals")
  list(
    @Param("projectId") projectId: string,
    @Param("phaseCode") phaseCode: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.service.list(projectId, phaseCode);
  }

  @Post("projects/:projectId/phases/:phaseCode/task-proposals/generate")
  generate(
    @Param("projectId") projectId: string,
    @Param("phaseCode") phaseCode: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.service.generate(projectId, phaseCode, body);
  }

  @Post("task-proposals/:proposalId/edit")
  edit(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.service.edit(proposalId, body);
  }

  @Post("task-proposals/:proposalId/accept")
  accept(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.service.accept(proposalId, body);
  }

  @Post("approvals/:requestId/decision")
  decide(
    @Param("requestId") requestId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "OWNER");
    return this.service.decide(requestId, body);
  }
}
