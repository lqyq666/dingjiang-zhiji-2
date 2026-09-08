import { Module } from "@nestjs/common";

import { Vs01DomainModule } from "../vs01-domain.module";
import { Vs01ContextAdapter } from "./context";
import { AssistantStore } from "./store";

@Module({
  imports: [Vs01DomainModule],
  providers: [AssistantStore, Vs01ContextAdapter],
  exports: [AssistantStore, Vs01ContextAdapter],
})
export class AssistantContextModule {}
