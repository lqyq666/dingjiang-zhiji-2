import { Module } from "@nestjs/common";

import { Vs01Service } from "../vs01.service";
import { Vs01DomainModule } from "../vs01-domain.module";
import { FeishuReviewGateway } from "./feishu/feishu-review.gateway";
import { CozeExperienceProvider } from "./providers/coze-experience.provider";
import { DemoExperienceProvider } from "./providers/demo-experience.provider";
import {
  EXPERIENCE_AI_PROVIDER,
  ExperienceIntelligenceService,
  FEISHU_REVIEW_GATEWAY,
} from "./experience-intelligence.service";
import { ExperienceIntelligenceController } from "./experience-intelligence.controller";
import { ExperienceAiRunStore } from "./store/experience-ai-run.store";
import { ExperienceCommandStore } from "./store/experience-command.store";

const present = (...values: Array<string | undefined>) =>
  values.every((value) => Boolean(value?.trim()));

@Module({
  imports: [Vs01DomainModule],
  controllers: [ExperienceIntelligenceController],
  providers: [
    ExperienceAiRunStore,
    ExperienceCommandStore,
    {
      provide: EXPERIENCE_AI_PROVIDER,
      useFactory: () =>
        present(
          process.env.COZE_API_TOKEN,
          process.env.COZE_EXTRACT_WORKFLOW_ID,
          process.env.COZE_PUBLISH_WORKFLOW_ID,
          process.env.COZE_ANSWER_WORKFLOW_ID,
        ) && process.env.COZE_PROVIDER_MODE === "COZE"
          ? new CozeExperienceProvider({
              token: process.env.COZE_API_TOKEN!,
              workflowIds: {
                extract: process.env.COZE_EXTRACT_WORKFLOW_ID!,
                publish: process.env.COZE_PUBLISH_WORKFLOW_ID!,
                answer: process.env.COZE_ANSWER_WORKFLOW_ID!,
              },
            })
          : new DemoExperienceProvider(),
    },
    {
      provide: FEISHU_REVIEW_GATEWAY,
      useFactory: () =>
        new FeishuReviewGateway(
          present(
            process.env.FEISHU_APP_ID,
            process.env.FEISHU_APP_SECRET,
            process.env.FEISHU_BASE_APP_TOKEN,
            process.env.FEISHU_REVIEW_TABLE_ID,
          ) && process.env.FEISHU_PROVIDER_MODE === "FEISHU"
            ? {
                mode: "FEISHU",
                appId: process.env.FEISHU_APP_ID,
                appSecret: process.env.FEISHU_APP_SECRET,
                baseAppToken: process.env.FEISHU_BASE_APP_TOKEN,
                reviewTableId: process.env.FEISHU_REVIEW_TABLE_ID,
              }
            : { mode: "DEMO_RULES" },
        ),
    },
    {
      provide: ExperienceIntelligenceService,
      inject: [
        Vs01Service,
        EXPERIENCE_AI_PROVIDER,
        FEISHU_REVIEW_GATEWAY,
        ExperienceAiRunStore,
        ExperienceCommandStore,
      ],
      useFactory: (
        vs01: Vs01Service,
        provider: ConstructorParameters<
          typeof ExperienceIntelligenceService
        >[1],
        feishu: FeishuReviewGateway,
        runs: ExperienceAiRunStore,
        commands: ExperienceCommandStore,
      ) =>
        new ExperienceIntelligenceService(
          vs01,
          provider,
          feishu,
          runs,
          commands,
        ),
    },
  ],
})
export class ExperienceIntelligenceModule {}
