import {
  Controller,
  Body,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";

import {
  IntegrationAuthGuard,
  IntegrationExceptionFilter,
  integrationCorrelationId,
  integrationPrincipal,
  type IntegrationRequest,
} from "./integration-http";
import { IntegrationService } from "./integration.service";
import { NextActionService } from "./next-action.service";

@Controller("integration")
@UseGuards(IntegrationAuthGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationController {
  constructor(
    @Inject(IntegrationService)
    private readonly integration: IntegrationService,
    @Inject(NextActionService)
    private readonly nextActions: NextActionService,
  ) {}

  private success(request: IntegrationRequest, data: unknown) {
    return {
      ok: true as const,
      data,
      correlationId: integrationCorrelationId(request),
    };
  }

  @Get("events")
  async events(@Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.events(integrationPrincipal(request)),
    );
  }

  @Get("projects/:id/operations")
  async executionContext(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.executionContext(
        integrationPrincipal(request),
        id,
      ),
    );
  }

  @Post("projects/:id/operations")
  async executeWork(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.executeWork(
        integrationPrincipal(request),
        id,
        body,
      ),
    );
  }

  @Get("projects/:id/evidence/proposals")
  async evidenceProposals(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.evidenceProposals(
        integrationPrincipal(request),
        id,
      ),
    );
  }

  @Post("projects/:id/evidence/confirmation")
  async confirmEvidence(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.confirmEvidence(
        integrationPrincipal(request),
        id,
        body,
      ),
    );
  }

  @Get("projects")
  async projects(@Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.projects(integrationPrincipal(request)),
    );
  }

  @Get("projects/current")
  async currentProject(@Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.currentProject(integrationPrincipal(request)),
    );
  }

  @Get("projects/current/work-item")
  async currentWorkItem(@Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.currentWorkItem(integrationPrincipal(request)),
    );
  }

  @Get("projects/:id/context")
  async projectContext(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.projectContext(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/state")
  async projectState(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.projectState(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/next-action")
  async nextAction(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.nextActions.derive(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/evidence")
  async evidence(@Param("id") id: string, @Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.evidence(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/materials")
  async materials(@Param("id") id: string, @Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.materials(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/work-items")
  async workItems(@Param("id") id: string, @Req() request: IntegrationRequest) {
    return this.success(
      request,
      await this.integration.workItems(integrationPrincipal(request), id),
    );
  }

  @Get("projects/:id/materials/:materialId/preview")
  async materialPreview(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.materialPreview(
        integrationPrincipal(request),
        id,
        materialId,
      ),
    );
  }

  @Get("projects/:id/evidence/:evidenceId")
  async evidenceDetail(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.evidenceDetail(
        integrationPrincipal(request),
        id,
        evidenceId,
      ),
    );
  }

  @Get("projects/:id/source-versions/:sourceVersionId")
  async sourceVersion(
    @Param("id") id: string,
    @Param("sourceVersionId") sourceVersionId: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.sourceVersion(
        integrationPrincipal(request),
        id,
        sourceVersionId,
      ),
    );
  }

  @Get("projects/:id/workpaper")
  async validationWorkpaper(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.validationWorkpaper(
        integrationPrincipal(request),
        id,
      ),
    );
  }

  @Post("projects/:id/workpaper/proposals")
  async proposeWorkpaper(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.proposeWorkpaper(
        integrationPrincipal(request),
        id,
        body,
      ),
    );
  }

  @Post("projects/:id/materials")
  async createMaterial(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.createMaterial(
        integrationPrincipal(request),
        id,
        body,
      ),
    );
  }

  @Post("projects/:id/evidence/proposals")
  async proposeEvidence(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.proposeEvidence(
        integrationPrincipal(request),
        id,
        body,
      ),
    );
  }

  @Post("projects/:id/materials/:materialId/verification")
  async verifyMaterial(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Body() body: unknown,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.verifyMaterial(
        integrationPrincipal(request),
        id,
        materialId,
        body,
      ),
    );
  }

  @Get("experiences/search")
  async searchExperiences(
    @Query("query") query: string | undefined,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.searchExperiences(
        integrationPrincipal(request),
        query ?? "",
      ),
    );
  }

  @Get("experiences/:id")
  async formalExperience(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.formalExperience(
        integrationPrincipal(request),
        id,
      ),
    );
  }

  @Get("experiences/:id/evidence")
  async experienceEvidence(
    @Param("id") id: string,
    @Req() request: IntegrationRequest,
  ) {
    return this.success(
      request,
      await this.integration.experienceEvidence(
        integrationPrincipal(request),
        id,
      ),
    );
  }
}
