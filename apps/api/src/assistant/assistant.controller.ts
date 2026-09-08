import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  assistantHistorySchema,
  assistantRunRequestSchema,
} from "@dingjiang/contracts";

import type { AssistantRunRequest, AssistantStreamEvent } from "./contracts";
import { AssistantService } from "./assistant.service";
import { assistantScopeFromRequest } from "./scope";

type SseResponse = {
  setHeader(name: string, value: string): void;
  flushHeaders?: () => void;
  write(chunk: string): void;
  end(): void;
  on(event: "close", listener: () => void): void;
};

const requestBody = (input: unknown): AssistantRunRequest => {
  const parsed = assistantRunRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new BadRequestException("岗位助手请求不接受权限范围或未知字段");
  return parsed.data;
};

const streamCursor = (value: string | undefined): string => {
  if (value === undefined) return "0";
  if (!/^\d+$/.test(value))
    throw new BadRequestException("实时助手游标必须是非负整数");
  return value;
};

export const publicStreamEvent = (
  event: AssistantStreamEvent,
): Record<string, unknown> => {
  const base = {
    cursor: event.cursor,
    sessionId: event.sessionId,
    runId: event.runId ?? "SYSTEM",
    stageCode: event.stageCode,
    occurredAt: event.occurredAt,
  };
  switch (event.type) {
    case "STATE_CHANGED":
      return {
        ...base,
        type: event.type,
        status: event.payload.state ?? "THINKING",
      };
    case "SUGGESTION": {
      const suggestion = event.payload.suggestion as
        Record<string, unknown> | undefined;
      return {
        ...base,
        type: event.type,
        suggestion: suggestion
          ? {
              classification: "PROPOSAL",
              answer: suggestion.answer,
              evidenceIds: suggestion.evidenceIds ?? [],
              nextAction: suggestion.nextAction ?? null,
            }
          : undefined,
      };
    }
    case "RUN_COMPLETED":
      return {
        ...base,
        type: event.type,
        provider: event.payload.provider ?? "DEMO_RULES",
      };
    case "TOOL_STARTED":
      return {
        ...base,
        type: event.type,
        toolName: event.payload.toolName ?? "get_current_work_context",
      };
    case "TOOL_COMPLETED":
      return {
        ...base,
        type: event.type,
        toolName: event.payload.toolName ?? "get_current_work_context",
        status: event.payload.status ?? "TEMPORARILY_UNAVAILABLE",
        evidenceIds: event.payload.evidenceIds ?? [],
      };
    case "TEXT_DELTA":
      return { ...base, type: event.type, text: event.payload.text ?? "…" };
    case "RUN_FAILED":
      return {
        ...base,
        type: event.type,
        reason: event.payload.reason ?? "助手运行失败",
      };
    case "STREAM_READY":
      return {
        ...base,
        type: event.type,
        latestCursor: event.payload.latestCursor ?? event.cursor,
      };
    default:
      return { ...base, type: event.type };
  }
};

const formatEvent = (event: AssistantStreamEvent): string =>
  `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(publicStreamEvent(event))}\n\n`;

@Controller("vs12/projects/:projectId/assistant")
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
  ) {}

  @Post("runs")
  createRun(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    return this.assistant.createRun(
      assistantScopeFromRequest(projectId, role),
      requestBody(body),
    );
  }

  @Get("history")
  async history(
    @Param("projectId") projectId: string,
    @Headers("x-vs01-role") role: string | undefined,
  ) {
    return assistantHistorySchema.parse(
      await this.assistant.history(assistantScopeFromRequest(projectId, role)),
    );
  }

  @Get("stream")
  async stream(
    @Param("projectId") projectId: string,
    @Query("after") after: string | undefined,
    @Headers("x-vs01-role") role: string | undefined,
    @Res() response: SseResponse,
  ): Promise<void> {
    const scope = assistantScopeFromRequest(projectId, role);
    const initialCursor = streamCursor(after);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    let cursor = initialCursor;
    let closed = false;
    const writeEvents = async () => {
      const events = await this.assistant.events(scope, cursor);
      for (const event of events) {
        response.write(formatEvent(event));
        cursor = event.cursor;
      }
    };
    await writeEvents();
    const ready = await this.assistant.streamReady(scope);
    if (ready) {
      response.write(formatEvent(ready));
      cursor = ready.cursor;
    }
    const timer = setInterval(() => {
      void writeEvents().catch(() => response.write(": heartbeat\n\n"));
    }, 1_000);
    response.on("close", () => {
      if (!closed) clearInterval(timer);
      closed = true;
    });
  }
}
