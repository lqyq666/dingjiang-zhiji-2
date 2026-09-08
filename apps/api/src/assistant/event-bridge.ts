import { Inject, Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { AssistantService } from "./assistant.service";
import type { AssistantWorkEvent } from "./contracts";
import { AssistantStore } from "./store";

/**
 * Durable outbox consumer. It may fail or restart freely: business facts have
 * already committed, while correlation-key uniqueness makes assistant runs idempotent.
 */
@Injectable()
export class AssistantEventBridge implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    @Inject(AssistantStore) private readonly store: AssistantStore,
    @Inject(AssistantService) private readonly assistant: AssistantService,
  ) {}

  onModuleInit(): void {
    void this.pollOnce().catch(() => undefined);
    this.timer = setInterval(
      () => void this.pollOnce().catch(() => undefined),
      1_000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async pollOnce(maximumCount = 20): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      await this.store.recoverExpiredWorkEvents();
      const claimed = await this.store.claimWorkEvents(maximumCount);
      for (const group of this.coalesce(claimed)) {
        try {
          await this.assistant.createRunForWorkEvent(
            group[0] as AssistantWorkEvent,
          );
          await this.store.markWorkEventsDelivered(
            group.map((event) => event.id),
          );
        } catch (error) {
          await this.store.retryOrFailWorkEvents(
            group.map((event) => event.id),
            error,
          );
        }
      }
      return claimed.length;
    } finally {
      this.polling = false;
    }
  }

  private coalesce(events: AssistantWorkEvent[]): AssistantWorkEvent[][] {
    const grouped = new Map<string, AssistantWorkEvent[]>();
    for (const event of events) {
      const group = grouped.get(event.correlationKey) ?? [];
      group.push(event);
      grouped.set(event.correlationKey, group);
    }
    return [...grouped.values()];
  }
}
