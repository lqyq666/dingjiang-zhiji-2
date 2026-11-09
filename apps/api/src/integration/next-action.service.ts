import { Inject, Injectable } from "@nestjs/common";
import {
  nextActionSchema,
  type IntegrationPrincipal,
  type NextAction,
} from "@dingjiang/contracts";

import { IntegrationService } from "./integration.service";

/**
 * Derives the single next action for a project.
 *
 * This is a business rule, not an adapter concern: the answer depends on the
 * stage, the current work item and the material gaps. It lives on the server so
 * a second front end cannot grow a different answer, and so the MCP tool is a
 * thin caller rather than a second implementation.
 */
@Injectable()
export class NextActionService {
  constructor(
    @Inject(IntegrationService)
    private readonly integration: IntegrationService,
  ) {}

  async derive(
    principal: IntegrationPrincipal,
    projectId: string,
  ): Promise<NextAction> {
    const [state, currentWorkItem, workItems, materials] = await Promise.all([
      this.integration.projectState(principal, projectId),
      this.integration.currentWorkItem(principal),
      this.integration.workItems(principal, projectId),
      this.integration.materials(principal, projectId),
    ]);

    // The current work item is global; scope it to the project being asked
    // about, falling back to the live item of the current stage.
    const item =
      currentWorkItem.projectId === projectId
        ? currentWorkItem.item
        : (workItems.items.find(
            (candidate) =>
              candidate.phaseCode === state.currentStage?.code &&
              candidate.origin === "LIVE" &&
              ["READY", "IN_PROGRESS", "WAITING_REVIEW", "RETURNED"].includes(
                candidate.status,
              ),
          ) ?? null);

    if (item)
      return nextActionSchema.parse({
        kind: "WORK_ITEM",
        projectId: state.id,
        workItemId: item.id,
        title: item.title,
        responsibleRole: item.owner,
        explanation: "当前服务端派生事项优先处理",
        classification: "PROPOSAL",
      });

    const gap = materials.gaps[0];
    if (gap)
      return nextActionSchema.parse({
        kind: "MATERIAL_GAP",
        projectId: state.id,
        requirementId: gap.requirementId,
        title: gap.label,
        explanation: `材料缺口状态为 ${gap.status}`,
        classification: "PROPOSAL",
      });

    return nextActionSchema.parse({
      kind: "HUMAN_GATE_OR_REVIEW",
      projectId: state.id,
      title: "查看当前状态对应的人工 gate 或完成条件",
      explanation: `项目状态为 ${state.status}`,
      classification: "PROPOSAL",
    });
  }
}
