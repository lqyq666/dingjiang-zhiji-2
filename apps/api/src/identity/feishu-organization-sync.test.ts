import { describe, expect, it } from "vitest";
import {
  FeishuOrganizationDirectory,
  planFeishuOrganizationSync,
} from "./feishu-organization-sync";

describe("Feishu organization identity sync", () => {
  it("maps tenant managers to OWNER and uniquely matches other active members to PMC", () => {
    const plan = planFeishuOrganizationSync(
      [
        {
          openId: "ou_manager00000001",
          active: true,
          tenantManager: true,
        },
        {
          openId: "ou_employee0000001",
          active: true,
          tenantManager: false,
        },
      ],
      [
        {
          id: "user-manager",
          role: "PMC",
          active: true,
          bindingOpenId: "ou_manager00000001",
          bindingActive: true,
        },
        {
          id: "user-employee",
          role: "PMC",
          active: true,
          bindingOpenId: null,
          bindingActive: false,
        },
        {
          id: "user-owner-breakglass",
          role: "OWNER",
          active: true,
          bindingOpenId: null,
          bindingActive: false,
        },
        {
          id: "user-expert",
          role: "EXPERT_REVIEWER",
          active: true,
          bindingOpenId: null,
          bindingActive: false,
        },
      ],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.changes).toEqual([
      {
        userId: "user-employee",
        openId: "ou_employee0000001",
        kind: "BIND",
        fromRole: "PMC",
        toRole: "PMC",
      },
      {
        userId: "user-manager",
        openId: "ou_manager00000001",
        kind: "ROLE",
        fromRole: "PMC",
        toRole: "OWNER",
      },
    ]);
    expect(plan.summary).toEqual({
      directoryUsers: 2,
      activeUsers: 2,
      tenantManagers: 1,
      roleChanges: 1,
      newBindings: 1,
      disabledAccounts: 0,
      unchanged: 0,
      manuallyManagedExperts: 1,
      unmanagedLocalAccounts: 1,
      blockers: 0,
    });
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads the application-authorized Feishu directory without exposing credentials", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        expect(init?.body).toContain('"app_id":"app-id"');
        return Response.json({ code: 0, tenant_access_token: "secret-token" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer secret-token",
      );
      if (url.includes("/contact/v3/scopes"))
        return Response.json({
          code: 0,
          data: {
            user_ids: ["ou_employee0000001", "ou_manager00000001"],
            department_ids: [],
            has_more: false,
          },
        });
      const manager = url.includes("ou_manager00000001");
      return Response.json({
        code: 0,
        data: {
          user: {
            open_id: manager ? "ou_manager00000001" : "ou_employee0000001",
            is_tenant_manager: manager,
            status: { is_activated: true, is_resigned: false },
          },
        },
      });
    };

    const directory = new FeishuOrganizationDirectory(
      { appId: "app-id", appSecret: "app-secret" },
      fetchImpl,
    );

    await expect(directory.listUsers()).resolves.toEqual([
      {
        openId: "ou_employee0000001",
        active: true,
        tenantManager: false,
      },
      {
        openId: "ou_manager00000001",
        active: true,
        tenantManager: true,
      },
    ]);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls)).not.toContain("app-secret");
  });

  it("includes users from authorized departments", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v3/tenant_access_token/internal"))
        return Response.json({ code: 0, tenant_access_token: "token" });
      if (url.includes("/contact/v3/scopes"))
        return Response.json({
          code: 0,
          data: {
            user_ids: [],
            department_ids: ["od-team"],
            has_more: false,
          },
        });
      if (url.includes("/users/find_by_department"))
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                open_id: "ou_teammember00001",
                is_tenant_manager: false,
                status: { is_activated: true, is_resigned: false },
              },
            ],
            has_more: false,
          },
        });
      if (url.includes("/departments/od-team/children"))
        return Response.json({
          code: 0,
          data: { items: [], has_more: false },
        });
      throw new Error(`Unexpected URL: ${url}`);
    };

    const directory = new FeishuOrganizationDirectory(
      { appId: "app-id", appSecret: "app-secret" },
      fetchImpl,
    );
    await expect(directory.listUsers()).resolves.toEqual([
      {
        openId: "ou_teammember00001",
        active: true,
        tenantManager: false,
      },
    ]);
  });
});
