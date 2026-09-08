import { describe, expect, it } from "vitest";
import type { EmployeeDashboard, Project } from "@dingjiang/contracts";
import { filterWorkRows, workRows } from "./work-queue";
import { employeeReturn } from "../lib/employee-return";

const project = (id: string, sourceTaskId: string, status = "DRAFT") =>
  ({
    id,
    sourceTaskId,
    name: "改善交付",
    status,
    progress: 0,
  }) as Project;
const dashboard = {
  highRiskOrders: [
    {
      orderId: "A",
      customer: "甲客户",
      primaryException: "缺料",
      promisedDate: "2026-09-01",
      forecastDate: "2026-09-03",
      delayDays: 2,
    },
  ],
  pendingTaskIds: ["MISSING"],
  projects: [project("P/A", "A"), project("P2", "B", "COMPLETED")],
} as EmployeeDashboard;
describe("employee queues and destinations", () => {
  it("labels the actual root-cause action instead of sending a draft project to solution work too early", () => {
    const row = workRows(
      {
        ...dashboard,
        projects: [
          {
            ...project("P3", "A"),
            phases: [
              {
                code: "ROOT_CAUSE_VALIDATION",
                status: "IN_PROGRESS",
                tasks: [
                  {
                    id: "root",
                    title: "核验主要原因并确认结论",
                    owner: "PMC",
                    origin: "LIVE",
                    status: "READY",
                  },
                ],
              },
            ],
          } as Project,
        ],
      },
      "projects",
    )[0]!;
    expect(row.action).toBe("核验原因");
    expect(row.detail).toBe("核验主要原因并确认结论");
    expect(row.progress).toBeUndefined();
  });
  it("shows each source once at home and never loses pending sources outside the risk list", () => {
    const rows = workRows(dashboard, "home");
    expect(rows.map((row) => row.id)).toEqual(["MISSING", "P/A", "P2"]);
    expect(rows.find((row) => row.id === "P/A")?.href).toBe("/project/P%2FA");
    expect(workRows(dashboard, "risks")[0]?.status).toBe("已记录判断");
    expect(workRows(dashboard, "risks")[0]?.completed).toBe(false);
  });
  it("filters completed projects without truncating the work queue", () => {
    const rows = workRows(
      {
        ...dashboard,
        projects: Array.from({ length: 9 }, (_, i) =>
          project("P" + i, "S" + i),
        ),
      },
      "home",
    );
    expect(filterWorkRows(rows, "", "active").length).toBe(11);
    expect(
      filterWorkRows(workRows(dashboard, "home"), "", "active").length,
    ).toBe(2);
    expect(
      filterWorkRows(workRows(dashboard, "home"), "甲客户", "all").map(
        (row) => row.id,
      ),
    ).toEqual(["P/A"]);
  });
  it("limits return destinations to known employee lists", () => {
    expect(employeeReturn("?from=%2Femployee%2Frisks").href).toBe(
      "/employee/risks",
    );
    expect(employeeReturn("?from=https://other.example")).toEqual({
      href: "/employee",
      label: "返回我的工作",
    });
    expect(employeeReturn("?from=/boss").href).toBe("/employee");
  });
});
