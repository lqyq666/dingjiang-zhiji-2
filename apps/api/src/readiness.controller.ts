import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createPool } from "./vs01-db";

export class ReadinessService implements OnModuleDestroy {
  private readonly pool = createPool();
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
  async check(): Promise<{ service: string; status: string }> {
    const root =
      process.env.VS15_MATERIAL_VAULT_ROOT ??
      path.resolve(process.cwd(), ".data/materials");
    const filename = path.join(root, `.health-${randomUUID()}`);
    let created = false;
    try {
      await this.pool.query("SELECT 1");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const file = await open(filename, "wx", 0o600);
      created = true;
      try {
        await file.writeFile("readiness");
        await file.sync();
      } finally {
        await file.close();
      }
      return { service: "api", status: "ready" };
    } catch {
      throw new ServiceUnavailableException("服务暂未就绪");
    } finally {
      if (created) await unlink(filename).catch(() => undefined);
    }
  }
}
@Controller("health")
export class ReadinessController {
  constructor(
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}
  @Get("ready") ready() {
    return this.readiness.check();
  }
}
