import { runtimeTenantId } from "./runtime-config";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
  UseGuards,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { ServerResponse } from "node:http";
import {
  experienceCandidateStructuredInputSchema,
  experienceCandidateStructuredResubmitInputSchema,
} from "@dingjiang/contracts";

import { Vs01Service } from "./vs01.service";
import { MaterialVerificationCommand } from "./materials/material-verification-command";
import { EvidenceConfirmationCommand } from "./evidence/evidence-confirmation-command";
import { GovernedCommandExceptionFilter } from "./command-kernel/governed-command-http";

type DemoRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";

const requireRole = (
  actual: string | undefined,
  expected: DemoRole | readonly DemoRole[],
): void => {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual as DemoRole))
    throw new ForbiddenException("当前角色无权执行此操作");
};

/** Multer may decode UTF-8 multipart filenames as latin1 on Windows. */
export const normalizeMulterOriginalName = (originalName: string): string => {
  if (!/[\u0080-\uffff]/.test(originalName)) return originalName;
  // busboy/Multer filenames can arrive as Windows-1252 glyphs for raw UTF-8 bytes.
  const cp1252 = new Map([
    [0x192, 0x83],
    [0x178, 0x9f],
  ]);
  const bytes: number[] = [];
  for (const character of originalName) {
    const point = character.codePointAt(0)!;
    const byte = point <= 0xff ? point : cp1252.get(point);
    if (byte === undefined) return originalName;
    bytes.push(byte);
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  const encoded = Buffer.from(decoded, "utf8");
  if (!encoded.equals(Buffer.from(bytes))) return originalName;
  return decoded;
};

/** Runs before the multipart interceptor, keeping unauthorized bytes out of the vault. */
export class PmcMaterialImportGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const role = request.headers["x-vs01-role"];
    requireRole(Array.isArray(role) ? role[0] : role, "PMC");
    return true;
  }
}

@Controller("vs01")
export class Vs01Controller {
  constructor(
    @Inject(Vs01Service) private readonly vs01: Vs01Service,
    @Optional()
    @Inject(MaterialVerificationCommand)
    private readonly materialVerification?: MaterialVerificationCommand,
    @Inject(EvidenceConfirmationCommand)
    private readonly evidenceConfirmation?: EvidenceConfirmationCommand,
  ) {}

  @Get("employee") employee(@Headers("x-vs01-role") role: string | undefined) {
    requireRole(role, "PMC");
    return this.vs01.employee();
  }

  @Get("boss") boss(@Headers("x-vs01-role") role: string | undefined) {
    requireRole(role, "OWNER");
    return this.vs01.boss();
  }

  @Get("tasks/:id") task(
    @Param("id") id: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.task(id);
  }

  @Post("tasks/:id/decision") decide(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.decideTask(id, body);
  }

  @Post("tasks/:id/decision/revert") revertDecision(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.revertTaskDecision(id, body);
  }

  @Post("tasks/:id/materials") addMaterial(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.addTaskMaterial(id, body);
  }

  @Post("tasks/:id/materials/import")
  @UseGuards(PmcMaterialImportGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  async importMaterial(
    @Param("id") id: string,
    @Body() body: unknown,
    @UploadedFile()
    file: { originalname: string; buffer: Buffer; size: number } | undefined,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    await this.vs01.importTaskMaterial(
      id,
      body,
      file && {
        originalName: normalizeMulterOriginalName(file.originalname),
        buffer: file.buffer,
        size: file.size,
      },
    );
    return this.vs01.task(id);
  }

  @Post("tasks/:id/materials/:materialId/withdraw")
  async withdrawMaterial(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    await this.vs01.withdrawTaskMaterial(id, materialId, body);
    return this.vs01.task(id);
  }

  @Post("projects/:projectId/materials/:materialId/verification")
  @UseFilters(GovernedCommandExceptionFilter)
  async verifyMaterial(
    @Param("projectId") projectId: string,
    @Param("materialId") materialId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    if (!this.materialVerification)
      throw new ServiceUnavailableException("材料核验命令不可用");
    if (
      !body ||
      typeof body !== "object" ||
      !("payload" in body) ||
      !body.payload ||
      typeof body.payload !== "object" ||
      !("materialId" in body.payload) ||
      body.payload.materialId !== materialId
    )
      throw new BadRequestException("材料路径与核验命令不一致");
    await this.materialVerification.execute(
      {
        tenantId: runtimeTenantId(),
        subjectId: "human-pmc-web",
        role: "PMC",
        scopes: ["material:verify"],
        projectIds: [projectId],
      },
      projectId,
      body,
    );
    const project = await this.vs01.project(projectId);
    return this.vs01.task(project.sourceTaskId);
  }

  @Post("projects/:projectId/evidence/proposals/:proposalId/review")
  @UseFilters(GovernedCommandExceptionFilter)
  async reviewEvidenceProposal(
    @Param("projectId") projectId: string,
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    if (!this.evidenceConfirmation)
      throw new ServiceUnavailableException("Evidence 人工确认命令不可用");
    if (
      !body ||
      typeof body !== "object" ||
      !("payload" in body) ||
      !body.payload ||
      typeof body.payload !== "object" ||
      !("proposalId" in body.payload) ||
      body.payload.proposalId !== proposalId
    )
      throw new BadRequestException("Proposal 路径与人工确认命令不一致");
    const result = await this.evidenceConfirmation.execute(
      {
        tenantId: runtimeTenantId(),
        subjectId: "human-pmc-web",
        role: "PMC",
        scopes: ["evidence:confirm"],
        projectIds: [projectId],
      },
      projectId,
      body,
    );
    return result;
  }

  @Get("projects/:projectId/evidence/proposals")
  evidenceProposals(
    @Param("projectId") projectId: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.evidenceProposals(projectId);
  }

  @Get("tasks/:id/materials/:materialId/content")
  async materialContent(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Headers("x-vs01-role") role: string | undefined,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    requireRole(role, "PMC");
    const content = await this.vs01.taskMaterialContent(id, materialId);
    response.setHeader("Content-Type", content.mediaType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(content.originalName)}`,
    );
    return new StreamableFile(content.stream);
  }

  @Post("tasks/:id/assistant") assistTask(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.assistTask(id, body);
  }

  @Post("projects") createProject(
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.createProject(body);
  }

  @Get("projects/:id") project(
    @Param("id") id: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, ["PMC", "OWNER", "EXPERT_REVIEWER"]);
    return this.vs01.project(id);
  }

  @Post("projects/:id/assistant") assistProject(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.assistProject(id, body);
  }

  @Post("projects/:id/assistant-feedback") createAssistantFeedback(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.createAssistantFeedback(id, body);
  }

  @Get("projects/:id/assistant-feedback") assistantFeedback(
    @Param("id") id: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.assistantFeedback(id);
  }

  @Post("projects/:id/assistant-feedback/:feedbackId/withdraw")
  withdrawAssistantFeedback(
    @Param("id") id: string,
    @Param("feedbackId") feedbackId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.withdrawAssistantFeedback(id, feedbackId, body);
  }

  @Post("projects/:id/submit") submit(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.submitProject(id, body);
  }

  @Post("projects/:id/approve") approve(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "OWNER");
    return this.vs01.approveProject(id, body);
  }

  @Post("projects/:id/return") returnProject(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "OWNER");
    return this.vs01.returnProject(id, body);
  }

  @Post("projects/:id/outcome") submitOutcome(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.submitOutcome(id, body);
  }

  @Post("projects/:id/outcome/reopen") reopenOutcome(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.reopenOutcome(id, body);
  }

  @Post("projects/:id/execution-review") reviewExecutionPhase(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.reviewExecutionPhase(id, body);
  }

  @Post("projects/:id/outcome/approve") approveOutcome(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "OWNER");
    return this.vs01.approveOutcome(id, body);
  }

  @Post("projects/:id/outcome/return") returnOutcome(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "OWNER");
    return this.vs01.returnOutcome(id, body);
  }

  @Post("projects/:id/experience-candidate") createExperienceCandidate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    const parsed = experienceCandidateStructuredInputSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("无效的结构化候选经验提交");
    return this.vs01.createExperienceCandidate(id, parsed.data);
  }

  @Post("projects/:id/experience-candidate/withdraw")
  withdrawExperienceCandidate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.withdrawExperienceCandidate(id, body);
  }

  @Post("projects/:id/experience-candidate/resubmit")
  resubmitExperienceCandidate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    const parsed =
      experienceCandidateStructuredResubmitInputSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("无效的结构化候选经验重提");
    return this.vs01.resubmitExperienceCandidate(id, parsed.data);
  }

  @Get("expert/experience-reviews") expertExperienceReviews(
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.vs01.expertExperienceReviews();
  }

  @Get("expert/experience-history") expertExperienceHistory(
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.vs01.expertExperienceHistory();
  }

  @Post("experience-candidates/:id/approve") approveExperienceCandidate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.vs01.approveExperienceCandidate(id, body);
  }

  @Post("experience-candidates/:id/return") returnExperienceCandidate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.vs01.returnExperienceCandidate(id, body);
  }

  @Get("experiences") experiences(
    @Query("query") query: string | undefined,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, ["PMC", "EXPERT_REVIEWER"]);
    return this.vs01.experiences(query ?? "");
  }

  @Get("experiences/:id") experience(
    @Param("id") id: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, ["PMC", "EXPERT_REVIEWER"]);
    return this.vs01.experience(id);
  }

  @Post("tasks/:id/experience-references") citeExperience(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.citeExperience(id, body);
  }

  @Post("tasks/:id/experience-references/:referenceId/withdraw")
  withdrawExperienceReference(
    @Param("id") id: string,
    @Param("referenceId") referenceId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.withdrawExperienceReference(id, referenceId, body);
  }

  @Post("experiences/:id/retract") retractExperience(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "EXPERT_REVIEWER");
    return this.vs01.retractExperience(id, body);
  }

  @Post("project-subtasks/:id/status") updateSubtask(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.updateSubtask(id, body);
  }

  @Post("reset") reset(
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    requireRole(role, "PMC");
    return this.vs01.reset(body);
  }
}
