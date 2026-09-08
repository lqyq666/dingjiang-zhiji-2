# 飞书 Base Schema Bootstrap

该工具只维护三个人工协作投影：现有 `VS17 经验审核`、`负责人决策台`、`知识质量运营台`。PostgreSQL 继续是事实源。

## 使用

`.env` 中必须存在 `FEISHU_PROVIDER_MODE=FEISHU`、应用凭证、Base token 和现有审核表 ID。工具只从本地环境读取它们，不打印或写入审计日志。

```powershell
pnpm feishu:schema:plan
pnpm feishu:schema:apply
pnpm feishu:schema:apply
pnpm feishu:schema:verify
```

- `plan`：只读当前表、字段、视图与审核表记录数，并输出 `EXISTS`、`CREATE_*`、`TYPE_CONFLICT`、`UNMANAGED_REMOTE_*` 和 `BLOCKED` 分类。
- `apply`：只串行创建缺失资源；已有同名资源不更新，不删除任何内容。
- `verify`：要求三张表、manifest 字段/选项和视图全部存在，并确认审核表记录数不少于实施前的 3 条。
- 本地审计写入 `.feishu-schema/audit.jsonl`；该目录被 Git 忽略。

现有 VS17 运行时代码使用 `候选版本 / 经营问题 / 采取做法 / 审核结果` 等兼容字段名。Bootstrap 保留这些已有字段，不创建同义重复列；新增字段采用指南中的稳定名称。

Manifest 的三个 logical resource 固定为 `experience_candidate_review`、`owner_decision`、`knowledge_quality`。经验审核中的稳定逻辑字段名会同时显示实际远端兼容字段名，例如 `候选版本ID → 候选版本`。`UNMANAGED_REMOTE_FIELD` 和 `UNMANAGED_REMOTE_VIEW` 只用于提示，不会生成删除或修改动作。

## 高级权限人工门

当前没有 `FEISHU_APPROVER_OPEN_ID` 和可验证的组织角色成员映射，因此工具不自动开启或修改高级权限，固定报告：

```text
NEED_HUMAN_FEISHU_PERMISSION
```

管理员最小动作：确认 PMC、OWNER、EXPERT_REVIEWER 的真实成员映射，然后按 `src/manifest.ts` 的 `feishuPermissionManifest` 在飞书高级权限界面创建或核对三个角色。Schema 完成不代表这些角色权限已生效。
