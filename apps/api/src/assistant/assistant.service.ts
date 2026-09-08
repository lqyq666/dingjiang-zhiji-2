import { Inject, Injectable } from "@nestjs/common";

import type {
  AssistantRun,
  AssistantRunRequest,
  AssistantRunSuggestion,
  AssistantScope,
  AssistantStreamEvent,
  AssistantSuggestion,
  AssistantWorkEvent,
} from "./contracts";
import { Vs01ContextAdapter } from "./context";
import {
  asProposal,
  DemoRulesRuntimeAdapter,
  PiRuntimeAdapter,
  type AssistantRuntimePort,
} from "./runtime";
import { AssistantStore } from "./store";

const publicRunSuggestion = (
  suggestion: AssistantSuggestion,
): AssistantRunSuggestion => ({
  classification: suggestion.classification,
  answer: suggestion.answer,
  evidenceIds: suggestion.evidenceIds,
  nextAction: suggestion.nextAction,
});

@Injectable()
export class AssistantService {
  constructor(
    @Inject(AssistantStore) private readonly store: AssistantStore,
    @Inject(Vs01ContextAdapter) private readonly context: Vs01ContextAdapter,
    private readonly piRuntime: AssistantRuntimePort = new PiRuntimeAdapter(),
    private readonly fallbackRuntime: AssistantRuntimePort = new DemoRulesRuntimeAdapter(),
  ) {}

  async createRun(
    scope: AssistantScope,
    request: AssistantRunRequest,
  ): Promise<AssistantRun> {
    const scoped = await this.resolveScope(scope);
    const sessionId = await this.store.ensureSession(scoped);
    const run = await this.store.createRun(sessionId, scoped, request);
    return this.executeRun(scoped, sessionId, run, request);
  }

  /** Processes the durable outbox envelope without giving the runtime write access. */
  async createRunForWorkEvent(
    event: AssistantWorkEvent,
  ): Promise<AssistantRun> {
    const scope: AssistantScope & { sourceTaskId: string } = {
      tenantId: event.tenantId,
      subjectId: `demo-${event.actorRole.toLowerCase()}`,
      role: event.actorRole,
      projectId: event.projectId,
      sourceTaskId: event.sourceTaskId,
      policyVersion: "VS12-1",
    };
    const sessionId = await this.store.ensureSession(scope);
    const persisted = await this.store.createWorkEventRun(
      sessionId,
      scope,
      event,
    );
    if (["COMPLETED", "FALLBACK", "FAILED"].includes(persisted.run.status))
      return persisted.run;
    return this.executeRun(scope, sessionId, persisted.run, {
      stageCode: event.stageCode ?? undefined,
      intent: "WORK_EVENT",
      question: "",
    });
  }

  async history(scope: AssistantScope) {
    const scoped = await this.resolveScope(scope);
    await this.store.ensureSession(scoped);
    return this.store.history(scoped);
  }

  async events(
    scope: AssistantScope,
    after?: string,
  ): Promise<AssistantStreamEvent[]> {
    return this.store.events(await this.resolveScope(scope), after);
  }

  async streamReady(
    scope: AssistantScope,
  ): Promise<AssistantStreamEvent | null> {
    const scoped = await this.resolveScope(scope);
    const history = await this.store.history(scoped);
    const run = history.runs.at(-1);
    if (!run) return null;
    return this.store.append(scoped, history.session.id, run, "STREAM_READY", {
      latestCursor: history.latestCursor,
    });
  }

  private async resolveScope(
    scope: AssistantScope,
  ): Promise<AssistantScope & { sourceTaskId: string }> {
    const project = await this.context.currentWorkContext(scope);
    if (project.status === "FORBIDDEN")
      throw new Error("Assistant project scope rejected");
    const sourceTaskId = String(
      (project.data?.sourceTask as { id?: string } | undefined)?.id ?? "",
    );
    if (!sourceTaskId) throw new Error("Assistant project has no source task");
    return { ...scope, sourceTaskId };
  }

  private async executeRun(
    scope: AssistantScope,
    sessionId: string,
    run: AssistantRun,
    request: AssistantRunRequest,
  ): Promise<AssistantRun> {
    await this.store.append(scope, sessionId, run, "RUN_STARTED", {
      state: "THINKING",
    });
    const thinking: AssistantRun = { ...run, status: "THINKING" };
    await this.store.updateRun(thinking);
    await this.store.append(scope, sessionId, thinking, "STATE_CHANGED", {
      state: "THINKING",
    });
    const completed = await this.executeWithFallback(scope, request, thinking);
    await this.store.updateRun(completed);
    await this.store.append(scope, sessionId, completed, "SUGGESTION", {
      suggestion: completed.suggestion,
    });
    await this.store.append(scope, sessionId, completed, "RUN_COMPLETED", {
      state: "SUGGESTING",
      provider: completed.provider,
    });
    return completed;
  }

  private async executeWithFallback(
    scope: AssistantScope,
    request: AssistantRunRequest,
    run: AssistantRun,
  ): Promise<AssistantRun> {
    let piError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const suggestion = asProposal(
          await this.piRuntime.run({ scope, request, context: this.context }),
        );
        return {
          ...run,
          status: suggestion.provider === "PI" ? "COMPLETED" : "FALLBACK",
          provider: suggestion.provider,
          completedAt: new Date().toISOString(),
          suggestion: publicRunSuggestion(suggestion),
          fallbackReason:
            suggestion.provider === "PI"
              ? null
              : (suggestion.fallbackReason ?? "Pi runtime unavailable"),
        };
      } catch (error) {
        piError = error;
      }
    }
    const fallback = asProposal(
      await this.fallbackRuntime.run({ scope, request, context: this.context }),
    );
    return {
      ...run,
      status: "FALLBACK",
      provider: "DEMO_RULES",
      completedAt: new Date().toISOString(),
      suggestion: publicRunSuggestion(fallback),
      fallbackReason:
        piError instanceof Error ? piError.message : "Pi runtime unavailable",
    };
  }
}
