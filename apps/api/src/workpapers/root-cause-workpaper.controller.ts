import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
} from "@nestjs/common";

import { RootCauseWorkpaperService } from "./root-cause-workpaper.service";

const requirePmc = (role: string | undefined): void => {
  if (role !== "PMC") throw new ForbiddenException("当前角色无权执行此操作");
};

@Controller("vs16")
export class RootCauseWorkpaperController {
  constructor(
    @Inject(RootCauseWorkpaperService)
    private readonly workpapers: RootCauseWorkpaperService,
  ) {}

  @Get("projects/:projectId/root-cause-workpaper")
  view(
    @Param("projectId") projectId: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requirePmc(role);
    return this.workpapers.view(projectId);
  }

  @Post("projects/:projectId/root-cause-workpaper/candidate-runs")
  candidate(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requirePmc(role);
    return this.workpapers.candidate(projectId, body);
  }

  @Put("projects/:projectId/root-cause-workpaper/draft")
  draft(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requirePmc(role);
    return this.workpapers.saveDraft(projectId, body);
  }

  @Post("projects/:projectId/root-cause-workpaper/complete")
  complete(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requirePmc(role);
    return this.workpapers.complete(projectId, body);
  }

  @Post("projects/:projectId/root-cause-workpaper/reopen")
  reopen(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requirePmc(role);
    return this.workpapers.reopen(projectId, body);
  }
}
