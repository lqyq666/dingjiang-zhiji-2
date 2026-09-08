import { Module } from "@nestjs/common";

import { Vs01DomainModule } from "../vs01-domain.module";
import { Vs01Service } from "../vs01.service";
import { FeishuApprovalNotifier } from "./feishu-approval.notifier";
import { TaskOrchestrationController } from "./task-orchestration.controller";
import { TaskOrchestrationService } from "./task-orchestration.service";

const present = (...values: Array<string | undefined>) =>
  values.every((value) => Boolean(value?.trim()));

@Module({
  imports: [Vs01DomainModule],
  controllers: [TaskOrchestrationController],
  providers: [
    {
      provide: FeishuApprovalNotifier,
      useFactory: () =>
        new FeishuApprovalNotifier(
          process.env.FEISHU_PROVIDER_MODE === "FEISHU" &&
            present(
              process.env.FEISHU_APP_ID,
              process.env.FEISHU_APP_SECRET,
              process.env.FEISHU_APPROVER_OPEN_ID,
            )
            ? {
                mode: "FEISHU",
                appId: process.env.FEISHU_APP_ID,
                appSecret: process.env.FEISHU_APP_SECRET,
                approverOpenId: process.env.FEISHU_APPROVER_OPEN_ID,
                publicUrl: process.env.DINGJIANG_PUBLIC_URL,
              }
            : { mode: "DEMO_RULES" },
        ),
    },
    {
      provide: TaskOrchestrationService,
      inject: [Vs01Service, FeishuApprovalNotifier],
      useFactory: (projects: Vs01Service, notifier: FeishuApprovalNotifier) =>
        new TaskOrchestrationService(projects, notifier),
    },
  ],
})
export class TaskOrchestrationModule {}
