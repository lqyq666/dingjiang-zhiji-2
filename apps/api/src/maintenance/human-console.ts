import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  governedCommandEnvelopeSchema,
  workExecutionRequestSchema,
  materialVerificationRequestSchema,
  evidenceConfirmationRequestSchema,
  type GovernedCommandEnvelope,
} from "@dingjiang/contracts";
import { createPool, databaseUrl } from "../vs01-db";
import {
  assertProductionConfig,
  isProduction,
  runtimeTenantId,
} from "../runtime-config";
import { IdentityService } from "../identity/identity.service";
import {
  parseBundle,
  sourceNames,
  type SourceName,
} from "../intake/source-bundle";
import { importSourceBundle } from "../intake/import-service";
import {
  approvalDigest,
  commandAuthorization,
  principalStillAuthorized,
  requiresHumanApproval,
} from "../command-kernel/production-authorization";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Json;
}
async function stdin(): Promise<Json> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 24 * 1024 * 1024)
      throw new Error("Maintenance input too large");
    parts.push(bytes);
  }
  return object(JSON.parse(Buffer.concat(parts).toString("utf8")));
}
function maintenanceUrl(): string {
  assertProductionConfig();
  if (!isProduction())
    throw new Error(
      "Human maintenance console requires an explicitly configured production-mode staging/enterprise instance",
    );
  const runtime = new URL(databaseUrl()),
    admin = new URL(process.env.MIGRATION_DATABASE_URL ?? "invalid");
  if (
    !["postgres:", "postgresql:"].includes(admin.protocol) ||
    !admin.password ||
    !admin.username ||
    admin.username === runtime.username ||
    admin.hostname !== runtime.hostname ||
    admin.port !== runtime.port ||
    admin.pathname !== runtime.pathname
  )
    throw new Error(
      "Use the separate maintenance identity on the same database",
    );
  return admin.toString();
}
async function effectiveEnvelope(
  pool: Pool,
  userId: string,
  input: Json,
): Promise<GovernedCommandEnvelope> {
  const command = object(input.command);
  const name = command.name;
  // Only exact existing domain schemas; approval never broadens accepted inputs.
  const schema =
    name === "work.execute"
      ? workExecutionRequestSchema
      : name === "material.verify"
        ? materialVerificationRequestSchema
        : name === "evidence.confirm"
          ? evidenceConfirmationRequestSchema
          : null;
  if (!schema)
    throw new Error("This command is not an approvable high-risk command");
  const request = schema.parse(command.request);
  const current = await pool.query(
    "SELECT u.id,u.role,c.id AS credential_id,c.scopes,c.project_ids FROM app_users u JOIN app_mcp_credentials c ON c.user_id=u.id AND c.tenant_id=u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2 AND u.active AND c.active AND c.expires_at>clock_timestamp() ORDER BY c.created_at DESC",
    [userId, runtimeTenantId()],
  );
  if (current.rowCount !== 1)
    throw new Error(
      "Exactly one active individual MCP credential is required; rotate ambiguous credentials",
    );
  const row = current.rows[0]!;
  const envelope = governedCommandEnvelopeSchema.parse({
    name,
    request,
    principal: {
      tenantId: runtimeTenantId(),
      subjectId: userId,
      credentialId: row.credential_id,
      role: row.role,
      scopes: row.scopes,
      projectIds: row.project_ids,
    },
    target: { tenantId: runtimeTenantId(), projectId: command.projectId },
  });
  if (
    !requiresHumanApproval(envelope.name, envelope.request.payload) ||
    !principalStillAuthorized(envelope, row)
  )
    throw new Error(
      "Account lacks the exact operation/project scope or approval is not needed",
    );
  return envelope;
}
async function registerApproval(
  pool: Pool,
  e: GovernedCommandEnvelope,
  digest: string,
): Promise<Json> {
  if (approvalDigest(e) !== digest)
    throw new Error(
      "Displayed operation changed; preview and confirm it again",
    );
  const client = await pool.connect();
  let committing = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${e.target.tenantId}:${e.name}:${e.request.requestId}`,
    ]);
    const account = await client.query(
      "SELECT role FROM app_users WHERE id=$1 AND tenant_id=$2 AND active FOR SHARE",
      [e.principal.subjectId, e.principal.tenantId],
    );
    const credential = await client.query(
      "SELECT scopes,project_ids FROM app_mcp_credentials WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND active AND expires_at>clock_timestamp() FOR SHARE",
      [e.principal.credentialId, e.principal.tenantId, e.principal.subjectId],
    );
    if (
      !principalStillAuthorized(
        e,
        account.rows[0] && credential.rows[0]
          ? { ...account.rows[0], ...credential.rows[0] }
          : undefined,
      )
    )
      throw new Error("Account or credential changed; authorization refused");
    const existing = await client.query(
      "SELECT approval_digest,expires_at,consumed_at,expires_at>clock_timestamp() AS valid FROM production_human_approvals WHERE tenant_id=$1 AND command_name=$2 AND request_id=$3",
      [e.target.tenantId, e.name, e.request.requestId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.approval_digest !== digest || (!row.valid && !row.consumed_at))
        throw new Error(
          "Request ID was already authorized differently or expired; obtain a new context and request ID",
        );
      committing = true;
      await client.query("COMMIT");
      return {
        ok: true,
        replayed: true,
        expiresAt: row.expires_at,
        consumed: Boolean(row.consumed_at),
        digest,
      };
    }
    const summary = {
      name: e.name,
      projectId: e.target.projectId,
      role: e.principal.role,
      request: e.request,
      scope: commandAuthorization(e.name, e.request.payload)?.scope,
    };
    const result = await client.query(
      "INSERT INTO production_human_approvals(id,tenant_id,actor_subject_id,actor_role,credential_id,command_name,request_id,project_id,expected_version,approval_digest,display_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING expires_at",
      [
        randomUUID(),
        e.target.tenantId,
        e.principal.subjectId,
        e.principal.role,
        e.principal.credentialId,
        e.name,
        e.request.requestId,
        e.target.projectId,
        e.request.expectedVersion,
        digest,
        JSON.stringify(summary),
      ],
    );
    await client.query(
      "INSERT INTO app_identity_events(tenant_id,subject_id,event_type,details) VALUES($1,$2,'HUMAN_COMMAND_AUTHORIZED',$3::jsonb)",
      [
        e.target.tenantId,
        e.principal.subjectId,
        JSON.stringify({
          requestId: e.request.requestId,
          name: e.name,
          projectId: e.target.projectId,
          digest,
        }),
      ],
    );
    committing = true;
    await client.query("COMMIT");
    return {
      ok: true,
      replayed: false,
      digest,
      expiresAt: result.rows[0]!.expires_at,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* do not mask failure */
    }
    if (committing)
      throw new Error(
        "Authorization commit result unknown; retry the identical request/digest, do not assume it failed",
        { cause: error },
      );
    throw error;
  } finally {
    client.release();
  }
}
export async function main(): Promise<void> {
  const input = await stdin();
  const pool = createPool(maintenanceUrl());
  const identity = new IdentityService(pool);
  let session: string | undefined;
  try {
    const login = await identity.login(
      input.username,
      input.password,
      "trusted-maintenance-console",
    );
    session = login.token;
    if (
      input.operation === "import.preview" ||
      input.operation === "import.commit"
    ) {
      if (!["OWNER", "PMC"].includes(login.user.role))
        throw new Error("OWNER/PMC import account required");
      const encoded = object(input.files);
      const decoded = {} as Record<SourceName, Buffer>;
      if (Object.keys(encoded).length !== 3)
        throw new Error("Exactly three CSV files are required");
      for (const name of sourceNames) {
        const text = encoded[name];
        if (typeof text !== "string" || text.length > 7 * 1024 * 1024)
          throw new Error("Invalid file encoding");
        decoded[name] = Buffer.from(text, "base64");
        if (decoded[name].toString("base64") !== text)
          throw new Error("Invalid canonical base64");
      }
      const bundle = parseBundle(String(input.batchId), decoded);
      if (input.operation === "import.preview")
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            tenantId: runtimeTenantId(),
            actor: login.user.username,
            batchId: bundle.batchId,
            digest: bundle.digest,
            files: bundle.files.map((f) => ({
              name: f.name,
              sha256: f.sha256,
              records: f.records.length,
              firstRecords: f.records.slice(0, 3),
            })),
            warning:
              "Full cumulative snapshot; no deletion. Import is not human verification of business truth.",
          }),
        );
      else {
        if (input.digest !== bundle.digest)
          throw new Error(
            "Displayed import digest does not match the exact bytes",
          );
        console.log(
          JSON.stringify(
            await importSourceBundle(
              pool,
              runtimeTenantId(),
              login.user.id,
              bundle,
            ),
          ),
        );
      }
    } else if (
      input.operation === "approval.preview" ||
      input.operation === "approval.commit"
    ) {
      const envelope = await effectiveEnvelope(pool, login.user.id, input);
      const digest = approvalDigest(envelope);
      if (input.operation === "approval.preview")
        console.log(
          JSON.stringify({
            tenantId: runtimeTenantId(),
            actor: login.user.username,
            role: envelope.principal.role,
            projectId: envelope.target.projectId,
            name: envelope.name,
            request: envelope.request,
            digest,
            validForMinutes: 10,
          }),
        );
      else
        console.log(
          JSON.stringify(
            await registerApproval(pool, envelope, String(input.digest)),
          ),
        );
    } else throw new Error("Unknown human maintenance operation");
  } finally {
    try {
      if (session) await identity.logout(session);
    } finally {
      await identity.onModuleDestroy();
    }
  }
}
if (require.main === module)
  void main().catch((error) => {
    console.error(
      error instanceof Error && !("code" in error)
        ? error.message
        : "Maintenance failed; inspect configuration and database health privately",
    );
    process.exitCode = 1;
  });
