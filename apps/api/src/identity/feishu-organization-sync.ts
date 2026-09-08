import { createHash } from "node:crypto";
import type { UserIdentity } from "./identity.service";

export type FeishuDirectoryUser = {
  openId: string;
  active: boolean;
  tenantManager: boolean;
};

export type LocalOrganizationAccount = {
  id: string;
  role: UserIdentity["role"];
  active: boolean;
  bindingOpenId: string | null;
  bindingActive: boolean;
};

export type FeishuOrganizationChange = {
  userId: string;
  openId: string;
  kind: "BIND" | "ROLE" | "DISABLE";
  fromRole: UserIdentity["role"];
  toRole: UserIdentity["role"];
};

export type FeishuOrganizationSyncPlan = {
  digest: string;
  changes: FeishuOrganizationChange[];
  blockers: string[];
  summary: {
    directoryUsers: number;
    activeUsers: number;
    tenantManagers: number;
    roleChanges: number;
    newBindings: number;
    disabledAccounts: number;
    unchanged: number;
    manuallyManagedExperts: number;
    unmanagedLocalAccounts: number;
    blockers: number;
  };
};

type FeishuDirectoryConfig = { appId: string; appSecret: string };

export class FeishuOrganizationDirectory {
  constructor(
    private readonly config: FeishuDirectoryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listUsers(): Promise<FeishuDirectoryUser[]> {
    if (!this.config.appId.trim() || !this.config.appSecret.trim())
      throw new Error("飞书组织同步配置不完整");
    const tokenPayload = await this.request(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );
    const token = textField(tokenPayload, "tenant_access_token");
    const userIds = new Set<string>();
    const departmentIds = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < 200; page += 1) {
      const url = new URL("https://open.feishu.cn/open-apis/contact/v3/scopes");
      url.searchParams.set("user_id_type", "open_id");
      url.searchParams.set("department_id_type", "open_department_id");
      url.searchParams.set("page_size", "100");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const payload = await this.request(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = objectField(payload, "data");
      for (const item of arrayField(data, "user_ids")) {
        if (typeof item !== "string") throw new Error("飞书成员标识无效");
        userIds.add(item);
      }
      for (const item of arrayField(data, "department_ids")) {
        if (typeof item !== "string" || !item.trim())
          throw new Error("飞书部门标识无效");
        departmentIds.add(item);
      }
      if (userIds.size > 10_000) throw new Error("飞书组织成员超过安全上限");
      if (data.has_more !== true) break;
      pageToken = textField(data, "page_token");
      if (page === 199) throw new Error("飞书通讯录分页超过安全上限");
    }

    const users = new Map<string, FeishuDirectoryUser>();
    for (const user of await Promise.all(
      [...userIds].map(async (openId) => {
        const url = new URL(
          `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
        );
        url.searchParams.set("user_id_type", "open_id");
        url.searchParams.set("department_id_type", "open_department_id");
        const payload = await this.request(url.toString(), {
          headers: { authorization: `Bearer ${token}` },
        });
        return normalizeDirectoryUser(
          objectField(objectField(payload, "data"), "user"),
        );
      }),
    ))
      users.set(user.openId, user);

    const pendingDepartments = [...departmentIds];
    const visitedDepartments = new Set<string>();
    while (pendingDepartments.length) {
      const departmentId = pendingDepartments.shift()!;
      if (visitedDepartments.has(departmentId)) continue;
      visitedDepartments.add(departmentId);
      if (visitedDepartments.size > 10_000)
        throw new Error("飞书组织部门超过安全上限");

      let userPageToken = "";
      for (let page = 0; page < 200; page += 1) {
        const url = new URL(
          "https://open.feishu.cn/open-apis/contact/v3/users/find_by_department",
        );
        url.searchParams.set("department_id", departmentId);
        url.searchParams.set("user_id_type", "open_id");
        url.searchParams.set("department_id_type", "open_department_id");
        url.searchParams.set("page_size", "50");
        if (userPageToken) url.searchParams.set("page_token", userPageToken);
        const payload = await this.request(url.toString(), {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = objectField(payload, "data");
        for (const item of arrayField(data, "items")) {
          if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error("飞书组织目录响应格式无效");
          const user = normalizeDirectoryUser(item as Record<string, unknown>);
          users.set(user.openId, user);
        }
        if (users.size > 10_000) throw new Error("飞书组织成员超过安全上限");
        if (data.has_more !== true) break;
        userPageToken = textField(data, "page_token");
        if (page === 199) throw new Error("飞书通讯录分页超过安全上限");
      }

      let departmentPageToken = "";
      for (let page = 0; page < 200; page += 1) {
        const url = new URL(
          `https://open.feishu.cn/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}/children`,
        );
        url.searchParams.set("department_id_type", "open_department_id");
        url.searchParams.set("page_size", "50");
        if (departmentPageToken)
          url.searchParams.set("page_token", departmentPageToken);
        const payload = await this.request(url.toString(), {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = objectField(payload, "data");
        for (const item of arrayField(data, "items")) {
          if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error("飞书组织目录响应格式无效");
          const department = item as Record<string, unknown>;
          const childId =
            typeof department.open_department_id === "string"
              ? department.open_department_id
              : textField(department, "department_id");
          if (!visitedDepartments.has(childId))
            pendingDepartments.push(childId);
        }
        if (data.has_more !== true) break;
        departmentPageToken = textField(data, "page_token");
        if (page === 199) throw new Error("飞书通讯录分页超过安全上限");
      }
    }

    return [...users.values()].sort((left, right) =>
      left.openId.localeCompare(right.openId),
    );
  }

  private async request(url: string, init?: RequestInit) {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !payload || typeof payload !== "object")
      throw new Error("飞书组织目录请求失败");
    const object = payload as Record<string, unknown>;
    if (object.code !== 0) throw new Error("飞书组织目录拒绝请求");
    return object;
  }
}

function normalizeDirectoryUser(
  user: Record<string, unknown>,
): FeishuDirectoryUser {
  const status = objectField(user, "status");
  return {
    openId: textField(user, "open_id"),
    active: status.is_activated === true && status.is_resigned !== true,
    tenantManager: user.is_tenant_manager === true,
  };
}

function objectField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const result = value[field];
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("飞书组织目录响应格式无效");
  return result as Record<string, unknown>;
}

function textField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result.trim())
    throw new Error("飞书组织目录响应格式无效");
  return result;
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const result = value[field];
  if (result === undefined || result === null) return [];
  if (!Array.isArray(result)) throw new Error("飞书组织目录响应格式无效");
  return result;
}

const openIdPattern = /^ou_[A-Za-z0-9_-]{8,80}$/;

export function planFeishuOrganizationSync(
  directoryUsers: FeishuDirectoryUser[],
  localAccounts: LocalOrganizationAccount[],
): FeishuOrganizationSyncPlan {
  if (!directoryUsers.length || directoryUsers.length > 10_000)
    throw new Error("飞书组织成员数量无效");
  const normalizedUsers = directoryUsers
    .map((user) => ({ ...user, openId: user.openId.trim() }))
    .sort((left, right) => left.openId.localeCompare(right.openId));
  if (
    normalizedUsers.some((user) => !openIdPattern.test(user.openId)) ||
    new Set(normalizedUsers.map((user) => user.openId)).size !==
      normalizedUsers.length
  )
    throw new Error("飞书组织成员标识无效或重复");

  const changes: FeishuOrganizationChange[] = [];
  const blockers: string[] = [];
  const consumedAccounts = new Set<string>();
  let unchanged = 0;
  const activeBindings = new Map(
    localAccounts
      .filter((account) => account.bindingActive && account.bindingOpenId)
      .map((account) => [account.bindingOpenId!, account]),
  );

  for (const user of normalizedUsers) {
    const bound = activeBindings.get(user.openId);
    if (!user.active) {
      if (bound?.active) {
        if (bound.role === "EXPERT_REVIEWER") {
          blockers.push(`EXPERT_REVIEWER_REQUIRES_MANUAL_DISABLE:${bound.id}`);
        } else {
          consumedAccounts.add(bound.id);
          changes.push({
            userId: bound.id,
            openId: user.openId,
            kind: "DISABLE",
            fromRole: bound.role,
            toRole: bound.role,
          });
        }
      } else {
        unchanged += 1;
      }
      continue;
    }

    const desiredRole: UserIdentity["role"] = user.tenantManager
      ? "OWNER"
      : "PMC";
    if (bound) {
      consumedAccounts.add(bound.id);
      if (!bound.active) {
        blockers.push(`BOUND_ACCOUNT_DISABLED:${bound.id}`);
      } else if (bound.role === "EXPERT_REVIEWER") {
        blockers.push(`EXPERT_REVIEWER_MANAGED_MANUALLY:${bound.id}`);
      } else if (bound.role === desiredRole) {
        unchanged += 1;
      } else {
        changes.push({
          userId: bound.id,
          openId: user.openId,
          kind: "ROLE",
          fromRole: bound.role,
          toRole: desiredRole,
        });
      }
      continue;
    }

    const candidates = localAccounts.filter(
      (account) =>
        account.active &&
        account.role === desiredRole &&
        !account.bindingActive &&
        !consumedAccounts.has(account.id),
    );
    if (candidates.length !== 1) {
      blockers.push(
        `UNBOUND_${desiredRole}_CANDIDATES_${candidates.length}:${user.openId}`,
      );
      continue;
    }
    const candidate = candidates[0]!;
    consumedAccounts.add(candidate.id);
    changes.push({
      userId: candidate.id,
      openId: user.openId,
      kind: "BIND",
      fromRole: candidate.role,
      toRole: candidate.role,
    });
  }

  changes.sort((left, right) => left.userId.localeCompare(right.userId));
  blockers.sort();
  const unmanagedLocalAccounts = localAccounts.filter(
    (account) =>
      account.active &&
      account.role !== "EXPERT_REVIEWER" &&
      !account.bindingActive &&
      !consumedAccounts.has(account.id),
  ).length;
  const summary = {
    directoryUsers: normalizedUsers.length,
    activeUsers: normalizedUsers.filter((user) => user.active).length,
    tenantManagers: normalizedUsers.filter(
      (user) => user.active && user.tenantManager,
    ).length,
    roleChanges: changes.filter((change) => change.kind === "ROLE").length,
    newBindings: changes.filter((change) => change.kind === "BIND").length,
    disabledAccounts: changes.filter((change) => change.kind === "DISABLE")
      .length,
    unchanged,
    manuallyManagedExperts: localAccounts.filter(
      (account) => account.active && account.role === "EXPERT_REVIEWER",
    ).length,
    unmanagedLocalAccounts,
    blockers: blockers.length,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({ changes, blockers, summary }))
    .digest("hex");
  return { digest, changes, blockers, summary };
}
