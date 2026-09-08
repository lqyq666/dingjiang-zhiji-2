import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { ReadinessController, ReadinessService } from "./readiness.controller";
import { AssistantController } from "./assistant/assistant.controller";
import { AssistantService } from "./assistant/assistant.service";
import { Vs01ContextAdapter } from "./assistant/context";
import { AssistantStore } from "./assistant/store";
import { AssistantContextModule } from "./assistant/context.module";
import { Vs01Controller } from "./vs01.controller";
import { RootCauseWorkpaperController } from "./workpapers/root-cause-workpaper.controller";
import { ExperienceIntelligenceModule } from "./experience-intelligence/experience-intelligence.module";
import { Vs01DomainModule } from "./vs01-domain.module";
import { TaskOrchestrationModule } from "./task-orchestration/task-orchestration.module";
import { IntegrationModule } from "./integration/integration.module";
import { IdentityModule } from "./identity/identity.module";

@Module({
  imports: [
    IdentityModule,
    Vs01DomainModule,
    AssistantContextModule,
    ExperienceIntelligenceModule,
    TaskOrchestrationModule,
    IntegrationModule,
  ],
  controllers: [
    HealthController,
    ReadinessController,
    Vs01Controller,
    AssistantController,
    RootCauseWorkpaperController,
  ],
  providers: [
    { provide: ReadinessService, useFactory: () => new ReadinessService() },
    {
      provide: AssistantService,
      inject: [AssistantStore, Vs01ContextAdapter],
      useFactory: (store: AssistantStore, context: Vs01ContextAdapter) =>
        new AssistantService(store, context),
    },
  ],
})
export class AppModule {}
