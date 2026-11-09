# API 接口面

本文件由 `node scripts/docs/api-surface.mjs` 从控制器源码生成，请勿手工编辑。
`tooling/architecture/api-surface.test.ts` 会在每次测试时核对它与代码是否一致。

共 85 个路由。

## AssistantController

来源：`apps/api/src/assistant/assistant.controller.ts`

| 方法 | 路径                                              | 处理函数    |
| ---- | ------------------------------------------------- | ----------- |
| POST | `/api/vs12/projects/:projectId/assistant/runs`    | `createRun` |
| GET  | `/api/vs12/projects/:projectId/assistant/history` | `history`   |
| GET  | `/api/vs12/projects/:projectId/assistant/stream`  | `stream`    |

## ExperienceIntelligenceController

来源：`apps/api/src/experience-intelligence/experience-intelligence.controller.ts`

| 方法 | 路径                                                       | 处理函数  |
| ---- | ---------------------------------------------------------- | --------- |
| POST | `/api/vs17/projects/:projectId/experience-drafts/ai`       | `draft`   |
| POST | `/api/vs17/experience-candidates/:candidateId/feishu/push` | `push`    |
| POST | `/api/vs17/feishu/reviews/pull`                            | `pull`    |
| POST | `/api/vs17/experiences/:experienceId/coze/publish`         | `publish` |
| POST | `/api/vs17/experience-answer`                              | `answer`  |

## HealthController

来源：`apps/api/src/health.controller.ts`

| 方法 | 路径          | 处理函数 |
| ---- | ------------- | -------- |
| GET  | `/api/health` | `check`  |

## IntegrationController

来源：`apps/api/src/integration/integration.controller.ts`

| 方法 | 路径                                                               | 处理函数              |
| ---- | ------------------------------------------------------------------ | --------------------- |
| GET  | `/api/integration/events`                                          | `events`              |
| GET  | `/api/integration/projects/:id/operations`                         | `executionContext`    |
| POST | `/api/integration/projects/:id/operations`                         | `executeWork`         |
| GET  | `/api/integration/projects/:id/evidence/proposals`                 | `evidenceProposals`   |
| POST | `/api/integration/projects/:id/evidence/confirmation`              | `confirmEvidence`     |
| GET  | `/api/integration/projects`                                        | `projects`            |
| GET  | `/api/integration/projects/current`                                | `currentProject`      |
| GET  | `/api/integration/projects/current/work-item`                      | `currentWorkItem`     |
| GET  | `/api/integration/projects/:id/context`                            | `projectContext`      |
| GET  | `/api/integration/projects/:id/state`                              | `projectState`        |
| GET  | `/api/integration/projects/:id/next-action`                        | `nextAction`          |
| GET  | `/api/integration/projects/:id/evidence`                           | `evidence`            |
| GET  | `/api/integration/projects/:id/materials`                          | `materials`           |
| GET  | `/api/integration/projects/:id/work-items`                         | `workItems`           |
| GET  | `/api/integration/projects/:id/materials/:materialId/preview`      | `materialPreview`     |
| GET  | `/api/integration/projects/:id/evidence/:evidenceId`               | `evidenceDetail`      |
| GET  | `/api/integration/projects/:id/source-versions/:sourceVersionId`   | `sourceVersion`       |
| GET  | `/api/integration/projects/:id/workpaper`                          | `validationWorkpaper` |
| POST | `/api/integration/projects/:id/workpaper/proposals`                | `proposeWorkpaper`    |
| POST | `/api/integration/projects/:id/materials`                          | `createMaterial`      |
| POST | `/api/integration/projects/:id/evidence/proposals`                 | `proposeEvidence`     |
| POST | `/api/integration/projects/:id/materials/:materialId/verification` | `verifyMaterial`      |
| GET  | `/api/integration/experiences/search`                              | `searchExperiences`   |
| GET  | `/api/integration/experiences/:id`                                 | `formalExperience`    |
| GET  | `/api/integration/experiences/:id/evidence`                        | `experienceEvidence`  |

## ReadinessController

来源：`apps/api/src/readiness.controller.ts`

| 方法 | 路径                | 处理函数 |
| ---- | ------------------- | -------- |
| GET  | `/api/health/ready` | `ready`  |

## TaskOrchestrationController

来源：`apps/api/src/task-orchestration/task-orchestration.controller.ts`

| 方法 | 路径                                                                      | 处理函数   |
| ---- | ------------------------------------------------------------------------- | ---------- |
| GET  | `/api/vs18/projects/:projectId/phases/:phaseCode/task-proposals`          | `list`     |
| POST | `/api/vs18/projects/:projectId/phases/:phaseCode/task-proposals/generate` | `generate` |
| POST | `/api/vs18/task-proposals/:proposalId/edit`                               | `edit`     |
| POST | `/api/vs18/task-proposals/:proposalId/accept`                             | `accept`   |
| POST | `/api/vs18/approvals/:requestId/decision`                                 | `decide`   |

## Vs01Controller

来源：`apps/api/src/vs01.controller.ts`

| 方法 | 路径                                                                  | 处理函数                      |
| ---- | --------------------------------------------------------------------- | ----------------------------- |
| GET  | `/api/vs01/employee`                                                  | `employee`                    |
| GET  | `/api/vs01/boss`                                                      | `boss`                        |
| GET  | `/api/vs01/tasks/:id`                                                 | `task`                        |
| POST | `/api/vs01/tasks/:id/decision`                                        | `decide`                      |
| POST | `/api/vs01/tasks/:id/decision/revert`                                 | `revertDecision`              |
| POST | `/api/vs01/tasks/:id/materials`                                       | `addMaterial`                 |
| POST | `/api/vs01/tasks/:id/materials/import`                                | `importMaterial`              |
| POST | `/api/vs01/tasks/:id/materials/:materialId/withdraw`                  | `withdrawMaterial`            |
| POST | `/api/vs01/projects/:projectId/materials/:materialId/verification`    | `verifyMaterial`              |
| POST | `/api/vs01/projects/:projectId/evidence/proposals/:proposalId/review` | `reviewEvidenceProposal`      |
| GET  | `/api/vs01/projects/:projectId/evidence/proposals`                    | `evidenceProposals`           |
| GET  | `/api/vs01/tasks/:id/materials/:materialId/content`                   | `materialContent`             |
| POST | `/api/vs01/tasks/:id/assistant`                                       | `assistTask`                  |
| POST | `/api/vs01/projects`                                                  | `createProject`               |
| GET  | `/api/vs01/projects/:id`                                              | `project`                     |
| POST | `/api/vs01/projects/:id/assistant`                                    | `assistProject`               |
| POST | `/api/vs01/projects/:id/assistant-feedback`                           | `createAssistantFeedback`     |
| GET  | `/api/vs01/projects/:id/assistant-feedback`                           | `assistantFeedback`           |
| POST | `/api/vs01/projects/:id/assistant-feedback/:feedbackId/withdraw`      | `withdrawAssistantFeedback`   |
| POST | `/api/vs01/projects/:id/submit`                                       | `submit`                      |
| POST | `/api/vs01/projects/:id/approve`                                      | `approve`                     |
| POST | `/api/vs01/projects/:id/return`                                       | `returnProject`               |
| POST | `/api/vs01/projects/:id/outcome`                                      | `submitOutcome`               |
| POST | `/api/vs01/projects/:id/outcome/reopen`                               | `reopenOutcome`               |
| POST | `/api/vs01/projects/:id/execution-review`                             | `reviewExecutionPhase`        |
| POST | `/api/vs01/projects/:id/outcome/approve`                              | `approveOutcome`              |
| POST | `/api/vs01/projects/:id/outcome/return`                               | `returnOutcome`               |
| POST | `/api/vs01/projects/:id/experience-candidate`                         | `createExperienceCandidate`   |
| POST | `/api/vs01/projects/:id/experience-candidate/withdraw`                | `withdrawExperienceCandidate` |
| POST | `/api/vs01/projects/:id/experience-candidate/resubmit`                | `resubmitExperienceCandidate` |
| GET  | `/api/vs01/expert/experience-reviews`                                 | `expertExperienceReviews`     |
| GET  | `/api/vs01/expert/experience-history`                                 | `expertExperienceHistory`     |
| POST | `/api/vs01/experience-candidates/:id/approve`                         | `approveExperienceCandidate`  |
| POST | `/api/vs01/experience-candidates/:id/return`                          | `returnExperienceCandidate`   |
| GET  | `/api/vs01/experiences`                                               | `experiences`                 |
| GET  | `/api/vs01/experiences/:id`                                           | `experience`                  |
| POST | `/api/vs01/tasks/:id/experience-references`                           | `citeExperience`              |
| POST | `/api/vs01/tasks/:id/experience-references/:referenceId/withdraw`     | `withdrawExperienceReference` |
| POST | `/api/vs01/experiences/:id/retract`                                   | `retractExperience`           |
| POST | `/api/vs01/project-subtasks/:id/status`                               | `updateSubtask`               |
| POST | `/api/vs01/reset`                                                     | `reset`                       |

## RootCauseWorkpaperController

来源：`apps/api/src/workpapers/root-cause-workpaper.controller.ts`

| 方法 | 路径                                                                | 处理函数    |
| ---- | ------------------------------------------------------------------- | ----------- |
| GET  | `/api/vs16/projects/:projectId/root-cause-workpaper`                | `view`      |
| POST | `/api/vs16/projects/:projectId/root-cause-workpaper/candidate-runs` | `candidate` |
| PUT  | `/api/vs16/projects/:projectId/root-cause-workpaper/draft`          | `draft`     |
| POST | `/api/vs16/projects/:projectId/root-cause-workpaper/complete`       | `complete`  |
| POST | `/api/vs16/projects/:projectId/root-cause-workpaper/reopen`         | `reopen`    |
