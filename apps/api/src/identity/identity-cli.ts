import "reflect-metadata";
import { createPool, databaseUrl } from "../vs01-db";
import { assertProductionConfig, isProduction } from "../runtime-config";
import { IdentityService, type UserIdentity } from "./identity.service";
import { FeishuOrganizationDirectory } from "./feishu-organization-sync";

type Input = {
  command?: unknown;
  username?: unknown;
  displayName?: unknown;
  password?: unknown;
  role?: unknown;
  projectIds?: unknown;
  feishuOpenId?: unknown;
  confirmDigest?: unknown;
};
async function readInput(): Promise<Input> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (Buffer.byteLength(data) > 32_768)
      throw new Error("Administrative input exceeds 32 KiB");
  }
  const input: unknown = JSON.parse(data);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a JSON object on stdin");
  return input as Input;
}
async function main(): Promise<void> {
  assertProductionConfig();
  const input = await readInput();
  if (input.command !== "feishu-org-sync" && typeof input.username !== "string")
    throw new Error("username is required");
  const username = typeof input.username === "string" ? input.username : "";
  let connectionString = databaseUrl();
  if (isProduction()) {
    const admin = process.env.MIGRATION_DATABASE_URL;
    if (!admin)
      throw new Error(
        "Run identity administration in the maintenance container only",
      );
    const source = new URL(admin);
    const runtime = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(source.protocol) ||
      source.username === runtime.username ||
      source.hostname !== runtime.hostname ||
      source.port !== runtime.port ||
      source.pathname !== runtime.pathname
    )
      throw new Error(
        "Administrative identity must be separate, for the same database",
      );
    connectionString = admin;
  }
  const identity = new IdentityService(createPool(connectionString));
  try {
    switch (input.command) {
      case "account-set": {
        if (
          typeof input.password !== "string" ||
          typeof input.displayName !== "string" ||
          typeof input.role !== "string"
        )
          throw new Error("Account fields are required");
        const id = await identity.setAccount({
          username,
          displayName: input.displayName,
          password: input.password,
          role: input.role as UserIdentity["role"],
        });
        console.log(JSON.stringify({ ok: true, userId: id }));
        break;
      }
      case "account-disable":
        await identity.disableAccount(username);
        console.log(JSON.stringify({ ok: true }));
        break;
      case "mcp-issue": {
        if (
          !Array.isArray(input.projectIds) ||
          input.projectIds.some((id) => typeof id !== "string")
        )
          throw new Error("projectIds must be a string array");
        const token = await identity.issueMcpToken(
          username,
          input.projectIds as string[],
        );
        // stdout is consumed into a private file by scripts/release/operator.py.
        console.log(JSON.stringify({ token, expiresInDays: 30 }));
        break;
      }
      case "mcp-revoke":
        await identity.revokeMcpTokens(username);
        console.log(JSON.stringify({ ok: true }));
        break;
      case "project-assign": {
        if (
          !Array.isArray(input.projectIds) ||
          input.projectIds.some((id) => typeof id !== "string")
        )
          throw new Error("projectIds must be a string array");
        const projectIds = await identity.assignProjects(
          username,
          input.projectIds as string[],
        );
        console.log(JSON.stringify({ ok: true, projectIds }));
        break;
      }
      case "feishu-bind": {
        if (typeof input.feishuOpenId !== "string")
          throw new Error("feishuOpenId is required");
        await identity.bindFeishu(username, input.feishuOpenId);
        console.log(JSON.stringify({ ok: true }));
        break;
      }
      case "feishu-org-sync": {
        if (
          input.confirmDigest !== undefined &&
          typeof input.confirmDigest !== "string"
        )
          throw new Error("confirmDigest must be a string");
        const directory = new FeishuOrganizationDirectory({
          appId: process.env.FEISHU_APP_ID ?? "",
          appSecret: process.env.FEISHU_APP_SECRET ?? "",
        });
        const result = await identity.syncFeishuOrganization(
          await directory.listUsers(),
          input.confirmDigest,
        );
        console.log(
          JSON.stringify({
            ok: true,
            status: result.status,
            digest: result.plan.digest,
            summary: result.plan.summary,
          }),
        );
        break;
      }
      default:
        throw new Error("Unknown administrative command");
    }
  } finally {
    await identity.onModuleDestroy();
  }
}
void main().catch((error) => {
  // SQL errors can embed connection details. Print only validation messages.
  console.error(
    error instanceof Error && !("code" in error)
      ? error.message
      : "Administrative operation failed; inspect database availability and schema",
  );
  process.exitCode = 1;
});
