import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  HttpException,
  UnauthorizedException,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Pool } from "pg";
import {
  integrationPrincipalSchema,
  type IntegrationPrincipal,
} from "@dingjiang/contracts";
import { createPool } from "../vs01-db";
import { runtimeTenantId } from "../runtime-config";
import { hashPassword, verifyPassword } from "./password";
import { productionWritesEnabled } from "../production-write-policy";
import {
  planFeishuOrganizationSync,
  type FeishuDirectoryUser,
  type LocalOrganizationAccount,
} from "./feishu-organization-sync";

export type UserIdentity = {
  id: string;
  username: string;
  displayName: string;
  role: "PMC" | "OWNER" | "EXPERT_REVIEWER";
};
export const sessionCookieName = "dingjiang_session";
export const secretHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const projectAllowlist = (projectIds: string[], allowEmpty = false) => {
  if (
    (!allowEmpty && !projectIds.length) ||
    projectIds.length > 100 ||
    projectIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id))
  )
    throw new Error(allowEmpty ? "项目分配列表无效" : "必须指定具体项目白名单");
  return [...new Set(projectIds)];
};

export class IdentityService implements OnModuleDestroy {
  private passwordChecks = 0;
  constructor(private readonly pool: Pool = createPool()) {}
  async onModuleDestroy() {
    await this.pool.end();
  }

  async login(username: unknown, password: unknown, address: string) {
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 80 ||
      password.length > 128
    )
      throw new UnauthorizedException("账号或密码不正确");
    const tenant = runtimeTenantId();
    const normalized = username.trim().toLowerCase();
    // Persisted counters work across API instances and process restarts.
    for (const [key, maximum] of [
      [`ip:${address}`, 200],
      [`user:${normalized}`, 10],
    ] as const) {
      const result = await this.pool.query(
        "INSERT INTO app_login_limits (tenant_id,key_hash,attempts,resets_at) VALUES ($1,$2,1,now()+interval '15 minutes') ON CONFLICT (tenant_id,key_hash) DO UPDATE SET attempts=CASE WHEN app_login_limits.resets_at <= now() THEN 1 ELSE app_login_limits.attempts+1 END, resets_at=CASE WHEN app_login_limits.resets_at <= now() THEN now()+interval '15 minutes' ELSE app_login_limits.resets_at END RETURNING attempts",
        [tenant, secretHash(key)],
      );
      if (Number(result.rows[0]?.attempts) > maximum)
        throw new HttpException("尝试次数过多，请 15 分钟后重试", 429);
    }
    const account = await this.pool.query(
      "SELECT id, username, display_name, role, password_hash, active FROM app_users WHERE tenant_id=$1 AND username=$2",
      [tenant, normalized],
    );
    const row = account.rows[0];
    if (this.passwordChecks >= 4)
      throw new HttpException("登录服务繁忙，请稍后重试", 429);
    this.passwordChecks += 1;
    let valid: boolean;
    try {
      valid = await verifyPassword(password, String(row?.password_hash ?? ""));
    } finally {
      this.passwordChecks -= 1;
    }
    if (!valid || !row?.active)
      throw new UnauthorizedException("账号或密码不正确");
    const token = randomBytes(32).toString("base64url");
    // Recheck active/password under the account lock: a concurrent password reset
    // or disable cannot create a new session from credentials just revoked.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT active,password_hash FROM app_users WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [row.id, tenant],
      );
      if (
        !current.rows[0]?.active ||
        current.rows[0]?.password_hash !== row.password_hash
      )
        throw new UnauthorizedException("账号或密码不正确");
      await client.query(
        "DELETE FROM app_sessions WHERE tenant_id=$1 AND expires_at <= now()",
        [tenant],
      );
      await client.query(
        "DELETE FROM app_login_limits WHERE tenant_id=$1 AND resets_at <= now()",
        [tenant],
      );
      // Successful logins must not lock an employee out after ten normal sign-ins.
      await client.query(
        "DELETE FROM app_login_limits WHERE tenant_id=$1 AND key_hash=$2",
        [tenant, secretHash(`user:${normalized}`)],
      );
      await client.query(
        "DELETE FROM app_sessions WHERE token_hash IN (SELECT token_hash FROM app_sessions WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC,token_hash DESC OFFSET 9)",
        [tenant, row.id],
      );
      await client.query(
        "INSERT INTO app_sessions (token_hash,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')",
        [secretHash(token), tenant, row.id],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type) VALUES ($1,$2,'LOGIN_SUCCEEDED')",
        [tenant, row.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { token, user: this.user(row) };
  }

  async session(token: string | undefined): Promise<UserIdentity> {
    if (!token || !/^[\w-]{43}$/.test(token))
      throw new UnauthorizedException("请先登录");
    const result = await this.pool.query(
      "SELECT u.id,u.username,u.display_name,u.role FROM app_sessions s JOIN app_users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.expires_at>now() AND u.active",
      [secretHash(token), runtimeTenantId()],
    );
    if (!result.rows[0])
      throw new UnauthorizedException("登录已失效，请重新登录");
    return this.user(result.rows[0]);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token)
      await this.pool.query(
        "DELETE FROM app_sessions WHERE token_hash=$1 AND tenant_id=$2",
        [secretHash(token), runtimeTenantId()],
      );
  }

  async mcpPrincipal(token: string): Promise<IntegrationPrincipal> {
    if (!/^[\w-]{43}$/.test(token))
      throw new UnauthorizedException("MCP 访问令牌无效");
    const result = await this.pool.query(
      "SELECT u.id,u.role,c.id AS credential_id,c.scopes,c.project_ids FROM app_mcp_credentials c JOIN app_users u ON u.id=c.user_id AND u.tenant_id=c.tenant_id WHERE c.token_hash=$1 AND c.tenant_id=$2 AND c.active AND c.expires_at > now() AND u.active",
      [secretHash(token), runtimeTenantId()],
    );
    const row = result.rows[0];
    if (!row) throw new UnauthorizedException("MCP 访问令牌无效");
    if (row.role === "PMC") {
      const assignments = await this.pool.query(
        "SELECT project_id FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), row.id],
      );
      const assigned = new Set(
        assignments.rows.map((item) => String(item.project_id)),
      );
      if (
        (row.project_ids as string[]).some(
          (projectId) => !assigned.has(projectId),
        )
      )
        throw new UnauthorizedException("MCP 访问令牌无效");
    }
    return integrationPrincipalSchema.parse({
      tenantId: runtimeTenantId(),
      subjectId: row.id,
      credentialId: row.credential_id,
      role: row.role,
      scopes: row.scopes,
      projectIds: row.project_ids,
    });
  }

  /** Administrative CLI only; no public account-management HTTP endpoint. */
  async setAccount(input: {
    username: string;
    displayName: string;
    role: UserIdentity["role"];
    password: string;
  }) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$/.test(input.username) ||
      !input.displayName.trim() ||
      input.displayName.length > 80 ||
      !["PMC", "OWNER", "EXPERT_REVIEWER"].includes(input.role)
    )
      throw new Error("账号字段无效");
    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `identity-admin:${runtimeTenantId()}`,
      ]);
      const old = await client.query(
        "SELECT id,role,active FROM app_users WHERE tenant_id=$1 AND username=$2 FOR UPDATE",
        [runtimeTenantId(), input.username.toLowerCase()],
      );
      if (
        old.rows[0]?.role === "OWNER" &&
        old.rows[0]?.active &&
        input.role !== "OWNER"
      ) {
        const owners = await client.query(
          "SELECT count(*)::int AS count FROM app_users WHERE tenant_id=$1 AND role='OWNER' AND active",
          [runtimeTenantId()],
        );
        if (Number(owners.rows[0]?.count) <= 1)
          throw new Error("不能降级最后一个有效负责人账号");
      }
      const result = await client.query(
        "INSERT INTO app_users (id,tenant_id,username,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,username) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,password_hash=EXCLUDED.password_hash,active=true,updated_at=now() RETURNING id",
        [
          randomUUID(),
          runtimeTenantId(),
          input.username.toLowerCase(),
          input.displayName,
          input.role,
          passwordHash,
        ],
      );
      const id = String(result.rows[0].id);
      if (input.role !== "PMC")
        await client.query(
          "DELETE FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2",
          [runtimeTenantId(), id],
        );
      await client.query(
        "DELETE FROM app_sessions WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type) VALUES ($1,$2,'ACCOUNT_CONFIGURED')",
        [runtimeTenantId(), id],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async disableAccount(username: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `identity-admin:${runtimeTenantId()}`,
      ]);
      const current = await client.query(
        "SELECT role,active FROM app_users WHERE tenant_id=$1 AND username=$2 FOR UPDATE",
        [runtimeTenantId(), username.toLowerCase()],
      );
      if (current.rows[0]?.role === "OWNER" && current.rows[0]?.active) {
        const owners = await client.query(
          "SELECT count(*)::int AS count FROM app_users WHERE tenant_id=$1 AND role='OWNER' AND active",
          [runtimeTenantId()],
        );
        if (Number(owners.rows[0]?.count) <= 1)
          throw new Error("不能停用最后一个有效负责人账号");
      }
      const result = await client.query(
        "UPDATE app_users SET active=false,updated_at=now() WHERE tenant_id=$1 AND username=$2 RETURNING id",
        [runtimeTenantId(), username.toLowerCase()],
      );
      if (!result.rows[0]) throw new Error("账号不存在");
      const id = result.rows[0].id;
      await client.query(
        "DELETE FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "UPDATE app_feishu_user_bindings SET active=false,updated_at=now() WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "DELETE FROM app_sessions WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), id],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type) VALUES ($1,$2,'ACCOUNT_DISABLED')",
        [runtimeTenantId(), id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async issueMcpToken(username: string, projectIds: string[]): Promise<string> {
    const normalizedProjectIds = projectAllowlist(projectIds);
    const client = await this.pool.connect();
    const token = randomBytes(32).toString("base64url");
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT id,role FROM app_users WHERE tenant_id=$1 AND username=$2 AND active FOR UPDATE",
        [runtimeTenantId(), username.toLowerCase()],
      );
      const row = result.rows[0];
      if (!row) throw new Error("账号不存在或已停用");
      if (row.role === "PMC") {
        const assignments = await client.query(
          "SELECT project_id FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2 AND project_id=ANY($3::text[])",
          [runtimeTenantId(), row.id, normalizedProjectIds],
        );
        if (assignments.rowCount !== normalizedProjectIds.length)
          throw new Error("项目未分配给该员工");
      }
      const scopes = [
        "project:read",
        "workitem:read",
        "material:read",
        "evidence:read",
        "workpaper:read",
        "experience:read",
        ...(!productionWritesEnabled()
          ? []
          : row.role === "OWNER"
            ? ["project:approve"]
            : row.role === "EXPERT_REVIEWER"
              ? ["experience:publish"]
              : [
                  "workitem:write",
                  "workpaper:write",
                  "material:write",
                  "material:verify",
                  "evidence:write",
                  "evidence:confirm",
                ]),
      ];
      await client.query(
        "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), row.id],
      );
      await client.query(
        "INSERT INTO app_mcp_credentials (token_hash,tenant_id,user_id,scopes,project_ids) VALUES ($1,$2,$3,$4,$5)",
        [
          secretHash(token),
          runtimeTenantId(),
          row.id,
          scopes,
          normalizedProjectIds,
        ],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type,details) VALUES ($1,$2,'MCP_TOKEN_ROTATED',$3::jsonb)",
        [
          runtimeTenantId(),
          row.id,
          JSON.stringify({ projectIds: normalizedProjectIds, scopes }),
        ],
      );
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Administrative CLI only; replaces the current PMC project assignment. */
  async assignProjects(username: string, projectIds: string[]) {
    const normalizedProjectIds = projectAllowlist(projectIds, true);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `identity-admin:${runtimeTenantId()}`,
      ]);
      const result = await client.query(
        "SELECT id,role FROM app_users WHERE tenant_id=$1 AND username=$2 AND active FOR UPDATE",
        [runtimeTenantId(), username.toLowerCase()],
      );
      const row = result.rows[0];
      if (!row) throw new Error("账号不存在或已停用");
      if (row.role !== "PMC") throw new Error("只有 PMC 员工可以分配项目");
      const conflict = await client.query(
        "SELECT project_id FROM app_project_assignments WHERE tenant_id=$1 AND project_id=ANY($2::text[]) AND user_id<>$3 LIMIT 1 FOR UPDATE",
        [runtimeTenantId(), normalizedProjectIds, row.id],
      );
      if (conflict.rowCount) throw new Error("项目已分配给其他员工");
      await client.query(
        "DELETE FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2 AND NOT (project_id=ANY($3::text[]))",
        [runtimeTenantId(), row.id, normalizedProjectIds],
      );
      await client.query(
        "INSERT INTO app_project_assignments(tenant_id,project_id,user_id) SELECT $1,project_id,$2 FROM unnest($3::text[]) AS project_id ON CONFLICT (tenant_id,project_id) DO NOTHING",
        [runtimeTenantId(), row.id, normalizedProjectIds],
      );
      await client.query(
        "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), row.id],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type,details) VALUES ($1,$2,'PROJECT_ASSIGNMENTS_SET',$3::jsonb)",
        [
          runtimeTenantId(),
          row.id,
          JSON.stringify({ projectIds: normalizedProjectIds }),
        ],
      );
      await client.query("COMMIT");
      return normalizedProjectIds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Administrative CLI only; one internal account maps to one Feishu user. */
  async bindFeishu(username: string, openId: string) {
    const normalized = openId.trim();
    if (!/^ou_[A-Za-z0-9_-]{8,80}$/.test(normalized))
      throw new Error("飞书 open_id 格式无效");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `identity-admin:${runtimeTenantId()}`,
      ]);
      const account = await client.query(
        "SELECT id FROM app_users WHERE tenant_id=$1 AND username=$2 AND active FOR UPDATE",
        [runtimeTenantId(), username.toLowerCase()],
      );
      if (!account.rows[0]) throw new Error("账号不存在或已停用");
      const userId = String(account.rows[0].id);
      const conflict = await client.query(
        "SELECT user_id FROM app_feishu_user_bindings WHERE tenant_id=$1 AND open_id=$2 AND user_id<>$3 AND active FOR UPDATE",
        [runtimeTenantId(), normalized, userId],
      );
      if (conflict.rowCount) throw new Error("飞书账号已绑定其他员工");
      await client.query(
        "INSERT INTO app_feishu_user_bindings(tenant_id,user_id,open_id) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,user_id) DO UPDATE SET open_id=EXCLUDED.open_id,active=true,updated_at=now()",
        [runtimeTenantId(), userId, normalized],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type,details) VALUES ($1,$2,'FEISHU_IDENTITY_BOUND',$3::jsonb)",
        [runtimeTenantId(), userId, JSON.stringify({ configured: true })],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Administrative CLI only; reconciles application-authorized Feishu users. */
  async syncFeishuOrganization(
    directoryUsers: FeishuDirectoryUser[],
    confirmDigest?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `identity-admin:${runtimeTenantId()}`,
      ]);
      const accounts = await client.query(
        "SELECT u.id,u.role,u.active,b.open_id,b.active AS binding_active FROM app_users u LEFT JOIN app_feishu_user_bindings b ON b.tenant_id=u.tenant_id AND b.user_id=u.id WHERE u.tenant_id=$1 ORDER BY u.id",
        [runtimeTenantId()],
      );
      const localAccounts: LocalOrganizationAccount[] = accounts.rows.map(
        (row) => ({
          id: String(row.id),
          role: row.role as UserIdentity["role"],
          active: row.active === true,
          bindingOpenId: row.open_id ? String(row.open_id) : null,
          bindingActive: row.binding_active === true,
        }),
      );
      const plan = planFeishuOrganizationSync(directoryUsers, localAccounts);
      if (!confirmDigest) {
        await client.query("ROLLBACK");
        return { status: "PREVIEW" as const, plan };
      }
      if (
        !/^[a-f0-9]{64}$/.test(confirmDigest) ||
        confirmDigest !== plan.digest
      )
        throw new Error("飞书组织同步摘要已变化，请重新预览");
      if (plan.blockers.length)
        throw new Error("飞书组织同步存在歧义，拒绝写入");

      const finalOwners = localAccounts.filter((account) => {
        const change = plan.changes.find(
          (candidate) => candidate.userId === account.id,
        );
        if (change?.kind === "DISABLE") return false;
        return account.active && (change?.toRole ?? account.role) === "OWNER";
      }).length;
      if (finalOwners < 1)
        throw new Error("不能停用或降级最后一个有效负责人账号");

      for (const change of plan.changes) {
        if (change.kind === "BIND") {
          await client.query(
            "INSERT INTO app_feishu_user_bindings(tenant_id,user_id,open_id) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,user_id) DO UPDATE SET open_id=EXCLUDED.open_id,active=true,updated_at=now()",
            [runtimeTenantId(), change.userId, change.openId],
          );
        } else if (change.kind === "ROLE") {
          await client.query(
            "UPDATE app_users SET role=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [runtimeTenantId(), change.userId, change.toRole],
          );
          if (change.toRole !== "PMC")
            await client.query(
              "DELETE FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2",
              [runtimeTenantId(), change.userId],
            );
          await client.query(
            "DELETE FROM app_sessions WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
          await client.query(
            "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
        } else {
          await client.query(
            "UPDATE app_users SET active=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [runtimeTenantId(), change.userId],
          );
          await client.query(
            "DELETE FROM app_project_assignments WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
          await client.query(
            "UPDATE app_feishu_user_bindings SET active=false,updated_at=now() WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
          await client.query(
            "DELETE FROM app_sessions WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
          await client.query(
            "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
            [runtimeTenantId(), change.userId],
          );
        }
        await client.query(
          "INSERT INTO app_identity_events (tenant_id,subject_id,event_type,details) VALUES ($1,$2,'FEISHU_ORGANIZATION_SYNCED',$3::jsonb)",
          [
            runtimeTenantId(),
            change.userId,
            JSON.stringify({
              kind: change.kind,
              fromRole: change.fromRole,
              toRole: change.toRole,
              directoryActive: change.kind !== "DISABLE",
              syncDigest: plan.digest,
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return { status: "APPLIED" as const, plan };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeMcpTokens(username: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query(
        "SELECT id FROM app_users WHERE tenant_id=$1 AND username=$2 FOR UPDATE",
        [runtimeTenantId(), username.toLowerCase()],
      );
      if (!user.rows[0]) throw new Error("账号不存在");
      await client.query(
        "UPDATE app_mcp_credentials SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [runtimeTenantId(), user.rows[0].id],
      );
      await client.query(
        "INSERT INTO app_identity_events (tenant_id,subject_id,event_type) VALUES ($1,$2,'MCP_TOKEN_REVOKED')",
        [runtimeTenantId(), user.rows[0].id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private user(row: Record<string, unknown>): UserIdentity {
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: row.role as UserIdentity["role"],
    };
  }
}
