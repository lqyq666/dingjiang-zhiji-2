import "reflect-metadata";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SafeExceptionFilter } from "./safe-exception.filter";

import { localWebOrigins } from "./local-web-origins";
import { assertProductionConfig, isProduction } from "./runtime-config";

const loadLocalEnv = (): void => {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (envPath) process.loadEnvFile(envPath);
};

async function bootstrap(): Promise<void> {
  loadLocalEnv();
  assertProductionConfig();
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: "8mb", strict: true });
  app.set("trust proxy", process.env.DINGJIANG_TRUST_PROXY === "1" ? 1 : false);
  if (isProduction()) app.useGlobalFilters(new SafeExceptionFilter());
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  const localOrigins = isProduction()
    ? new Set([process.env.WEB_ORIGIN!])
    : localWebOrigins(process.env.WEB_ORIGIN);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, !origin || localOrigins.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "content-type",
      "x-vs01-role",
      "authorization",
      "x-correlation-id",
    ],
  });
  app.use(
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      next();
    },
  );
  const server = app.getHttpServer() as Server;
  server.requestTimeout = 35_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  await app.listen(
    Number(process.env.PORT ?? 3001),
    process.env.API_HOST ?? "127.0.0.1",
  );
}

void bootstrap().catch(() => {
  console.error(
    "API startup failed; check release configuration and database readiness",
  );
  process.exitCode = 1;
});
