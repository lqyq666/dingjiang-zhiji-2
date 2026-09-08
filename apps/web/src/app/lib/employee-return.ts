const employeeLists: Record<string, string> = {
  "/employee": "返回我的工作",
  "/employee/risks": "返回经营异常",
  "/employee/projects": "返回咨询任务",
  "/employee/confirmations": "返回待确认",
};
export function employeeReturn(search: string, fallback = "/employee") {
  const requested = new URLSearchParams(search).get("from");
  const href =
    requested && Object.hasOwn(employeeLists, requested) ? requested : fallback;
  return { href, label: employeeLists[href] ?? "返回我的工作" };
}
