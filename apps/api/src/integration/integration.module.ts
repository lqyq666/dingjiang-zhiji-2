import { WorkExecutionService } from "./work-execution.service";
import { Module } from "@nestjs/common";

import { AssistantContextModule } from "../assistant/context.module";
import { CommandKernelModule } from "../command-kernel/command-kernel.module";
import { Vs01DomainModule } from "../vs01-domain.module";
import { IntegrationController } from "./integration.controller";
import {
  IntegrationAuthGuard,
  IntegrationExceptionFilter,
} from "./integration-http";
import { IntegrationService } from "./integration.service";
import { RateLimitService } from "./rate-limit.service";
import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { WorkpaperProposalCommand } from "../workpapers/workpaper-proposal-command";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { EvidenceProposalCommand } from "../evidence/evidence-proposal-command";
import { FeishuWorkNotifier } from "./feishu-work.notifier";

@Module({
  imports: [AssistantContextModule, CommandKernelModule, Vs01DomainModule],
  controllers: [IntegrationController],
  providers: [
    IntegrationAuthGuard,
    IntegrationExceptionFilter,
    RateLimitService,
    {
      provide: WorkpaperProposalCommand,
      inject: [GovernedCommandKernel],
      useFactory: (kernel: GovernedCommandKernel) =>
        new WorkpaperProposalCommand(kernel),
    },
    {
      provide: MaterialCreateCommand,
      inject: [GovernedCommandKernel],
      useFactory: (kernel: GovernedCommandKernel) =>
        new MaterialCreateCommand(kernel),
    },
    {
      provide: EvidenceProposalCommand,
      inject: [GovernedCommandKernel],
      useFactory: (kernel: GovernedCommandKernel) =>
        new EvidenceProposalCommand(kernel),
    },
    {
      provide: FeishuWorkNotifier,
      useFactory: () =>
        new FeishuWorkNotifier({
          mode:
            process.env.FEISHU_PROVIDER_MODE === "FEISHU"
              ? "FEISHU"
              : "DEMO_RULES",
          appId: process.env.FEISHU_APP_ID,
          appSecret: process.env.FEISHU_APP_SECRET,
          publicUrl: process.env.DINGJIANG_PUBLIC_URL,
        }),
    },
    WorkExecutionService,
    IntegrationService,
  ],
})
export class IntegrationModule {}
