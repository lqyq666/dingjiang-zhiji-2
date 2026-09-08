import type { FeishuFieldKind, FieldManifest, TableManifest } from "./manifest";

export type FeishuFieldSnapshot = {
  id: string;
  name: string;
  kind: FeishuFieldKind | "unknown";
  options: readonly string[];
};

export type FeishuViewSnapshot = { id: string; name: string; type: string };

export type FeishuTableSnapshot = {
  id: string;
  name: string;
  recordCount: number | null;
  fields: readonly FeishuFieldSnapshot[];
  views: readonly FeishuViewSnapshot[];
};

export type FeishuSchemaSnapshot = { tables: readonly FeishuTableSnapshot[] };

export type SchemaAction =
  | { type: "create_table"; table: TableManifest }
  | {
      type: "create_field";
      tableId: string;
      tableName: string;
      field: FieldManifest;
    }
  | {
      type: "create_view";
      tableId: string;
      tableName: string;
      viewName: string;
    };

export type SchemaConflict = {
  table: string;
  field?: string;
  message: string;
};

export type SchemaDiffStatus =
  | "EXISTS"
  | "CREATE_TABLE"
  | "CREATE_FIELD"
  | "CREATE_VIEW"
  | "TYPE_CONFLICT"
  | "UNMANAGED_REMOTE_FIELD"
  | "UNMANAGED_REMOTE_VIEW"
  | "BLOCKED";

export type SchemaDiff = {
  status: SchemaDiffStatus;
  logicalResource: TableManifest["logicalResource"];
  table: string;
  resource: "table" | "field" | "view";
  name: string;
  remoteName?: string;
  message?: string;
};

export type SchemaPlan = {
  actions: readonly SchemaAction[];
  conflicts: readonly SchemaConflict[];
  diff: readonly SchemaDiff[];
  destructiveChanges: 0;
};

export type FeishuSchemaWriter = {
  createTable(table: TableManifest): Promise<string>;
  createField(tableId: string, field: FieldManifest): Promise<string>;
  createView(tableId: string, viewName: string): Promise<string>;
};

export type AppliedSchemaAction = {
  type: SchemaAction["type"];
  tableName: string;
  resourceName: string;
  resourceId: string;
};

export class FeishuSchemaConflictError extends Error {
  constructor(readonly conflicts: readonly SchemaConflict[]) {
    super("Feishu schema has non-destructive conflicts");
    this.name = "FeishuSchemaConflictError";
  }
}

export function planFeishuSchema(
  manifest: readonly TableManifest[],
  snapshot: FeishuSchemaSnapshot,
  configuredTableIds: Readonly<Record<string, string | undefined>>,
): SchemaPlan {
  const actions: SchemaAction[] = [];
  const conflicts: SchemaConflict[] = [];
  const diff: SchemaDiff[] = [];

  for (const expectedTable of manifest) {
    const configuredId = expectedTable.existingTableIdEnv
      ? configuredTableIds[expectedTable.existingTableIdEnv]
      : undefined;
    const matchingTables = configuredId
      ? snapshot.tables.filter((candidate) => candidate.id === configuredId)
      : snapshot.tables.filter(
          (candidate) => candidate.name === expectedTable.name,
        );
    const table = matchingTables[0];

    if (!table) {
      if (configuredId) {
        const message = `configured table ${configuredId} was not found`;
        conflicts.push({
          table: expectedTable.name,
          message,
        });
        diff.push(tableDiff(expectedTable, "BLOCKED", message));
      } else {
        actions.push({ type: "create_table", table: expectedTable });
        diff.push(tableDiff(expectedTable, "CREATE_TABLE"));
        for (const field of expectedTable.fields) {
          diff.push(fieldDiff(expectedTable, field, "CREATE_FIELD"));
        }
        for (const viewName of expectedTable.views) {
          diff.push(viewDiff(expectedTable, viewName, "CREATE_VIEW"));
        }
      }
      continue;
    }

    if (matchingTables.length > 1) {
      const message = `multiple remote tables match ${expectedTable.name}`;
      conflicts.push({ table: expectedTable.name, message });
      diff.push(tableDiff(expectedTable, "BLOCKED", message));
      continue;
    }

    diff.push(tableDiff(expectedTable, "EXISTS"));

    for (const expectedField of expectedTable.fields) {
      const matchingFields = table.fields.filter(
        (candidate) => candidate.name === expectedField.name,
      );
      const field = matchingFields[0];
      if (!field) {
        actions.push({
          type: "create_field",
          tableId: table.id,
          tableName: table.name,
          field: expectedField,
        });
        diff.push(fieldDiff(expectedTable, expectedField, "CREATE_FIELD"));
        continue;
      }
      if (matchingFields.length > 1) {
        const message = `multiple remote fields match ${expectedField.name}`;
        conflicts.push({ table: table.name, field: field.name, message });
        diff.push(fieldDiff(expectedTable, expectedField, "BLOCKED", message));
        continue;
      }
      if (field.kind !== expectedField.kind) {
        const message = `expected ${expectedField.kind}, found ${field.kind}`;
        conflicts.push({
          table: table.name,
          field: field.name,
          message,
        });
        diff.push(
          fieldDiff(expectedTable, expectedField, "TYPE_CONFLICT", message),
        );
        continue;
      }
      const missingOptions = (expectedField.options ?? []).filter(
        (option) => !field.options.includes(option),
      );
      if (missingOptions.length > 0) {
        const message = `missing select options: ${missingOptions.join(", ")}`;
        conflicts.push({
          table: table.name,
          field: field.name,
          message,
        });
        diff.push(fieldDiff(expectedTable, expectedField, "BLOCKED", message));
        continue;
      }
      diff.push(fieldDiff(expectedTable, expectedField, "EXISTS"));
    }

    for (const remoteField of table.fields) {
      if (
        !expectedTable.fields.some((field) => field.name === remoteField.name)
      ) {
        diff.push({
          status: "UNMANAGED_REMOTE_FIELD",
          logicalResource: expectedTable.logicalResource,
          table: expectedTable.name,
          resource: "field",
          name: remoteField.name,
          remoteName: remoteField.name,
        });
      }
    }

    for (const viewName of expectedTable.views) {
      const matchingViews = table.views.filter(
        (view) => view.name === viewName,
      );
      if (matchingViews.length === 0) {
        actions.push({
          type: "create_view",
          tableId: table.id,
          tableName: table.name,
          viewName,
        });
        diff.push(viewDiff(expectedTable, viewName, "CREATE_VIEW"));
      } else if (matchingViews.length > 1) {
        const message = `multiple remote views match ${viewName}`;
        conflicts.push({ table: table.name, message });
        diff.push(viewDiff(expectedTable, viewName, "BLOCKED", message));
      } else {
        diff.push(viewDiff(expectedTable, viewName, "EXISTS"));
      }
    }

    for (const remoteView of table.views) {
      if (!expectedTable.views.includes(remoteView.name)) {
        diff.push({
          status: "UNMANAGED_REMOTE_VIEW",
          logicalResource: expectedTable.logicalResource,
          table: expectedTable.name,
          resource: "view",
          name: remoteView.name,
          remoteName: remoteView.name,
        });
      }
    }
  }

  return { actions, conflicts, diff, destructiveChanges: 0 };
}

function tableDiff(
  table: TableManifest,
  status: Extract<SchemaDiffStatus, "EXISTS" | "CREATE_TABLE" | "BLOCKED">,
  message?: string,
): SchemaDiff {
  return {
    status,
    logicalResource: table.logicalResource,
    table: table.name,
    resource: "table",
    name: table.logicalResource,
    remoteName: table.name,
    ...(message ? { message } : {}),
  };
}

function fieldDiff(
  table: TableManifest,
  field: FieldManifest,
  status: Extract<
    SchemaDiffStatus,
    "EXISTS" | "CREATE_FIELD" | "TYPE_CONFLICT" | "BLOCKED"
  >,
  message?: string,
): SchemaDiff {
  return {
    status,
    logicalResource: table.logicalResource,
    table: table.name,
    resource: "field",
    name: field.key,
    remoteName: field.name,
    ...(message ? { message } : {}),
  };
}

function viewDiff(
  table: TableManifest,
  viewName: string,
  status: Extract<SchemaDiffStatus, "EXISTS" | "CREATE_VIEW" | "BLOCKED">,
  message?: string,
): SchemaDiff {
  return {
    status,
    logicalResource: table.logicalResource,
    table: table.name,
    resource: "view",
    name: viewName,
    remoteName: viewName,
    ...(message ? { message } : {}),
  };
}

export async function applyFeishuSchema(
  plan: SchemaPlan,
  writer: FeishuSchemaWriter,
): Promise<readonly AppliedSchemaAction[]> {
  if (plan.conflicts.length > 0)
    throw new FeishuSchemaConflictError(plan.conflicts);
  const applied: AppliedSchemaAction[] = [];
  for (const action of plan.actions) {
    if (action.type === "create_table") {
      const tableId = await writer.createTable(action.table);
      applied.push({
        type: action.type,
        tableName: action.table.name,
        resourceName: action.table.name,
        resourceId: tableId,
      });
      for (const viewName of action.table.views.slice(1)) {
        const viewId = await writer.createView(tableId, viewName);
        applied.push({
          type: "create_view",
          tableName: action.table.name,
          resourceName: viewName,
          resourceId: viewId,
        });
      }
      continue;
    }
    if (action.type === "create_field") {
      const fieldId = await writer.createField(action.tableId, action.field);
      applied.push({
        type: action.type,
        tableName: action.tableName,
        resourceName: action.field.name,
        resourceId: fieldId,
      });
      continue;
    }
    const viewId = await writer.createView(action.tableId, action.viewName);
    applied.push({
      type: action.type,
      tableName: action.tableName,
      resourceName: action.viewName,
      resourceId: viewId,
    });
  }
  return applied;
}

export function verifyFeishuSchema(
  manifest: readonly TableManifest[],
  snapshot: FeishuSchemaSnapshot,
  configuredTableIds: Readonly<Record<string, string | undefined>>,
): { ok: boolean; plan: SchemaPlan; recordCountFailures: readonly string[] } {
  const plan = planFeishuSchema(manifest, snapshot, configuredTableIds);
  const recordCountFailures: string[] = [];
  for (const tableManifest of manifest) {
    if (tableManifest.minimumRecordCount === undefined) continue;
    const configuredId = tableManifest.existingTableIdEnv
      ? configuredTableIds[tableManifest.existingTableIdEnv]
      : undefined;
    const table = configuredId
      ? snapshot.tables.find((candidate) => candidate.id === configuredId)
      : snapshot.tables.find(
          (candidate) => candidate.name === tableManifest.name,
        );
    if (
      !table ||
      table.recordCount === null ||
      table.recordCount < tableManifest.minimumRecordCount
    ) {
      recordCountFailures.push(
        `${tableManifest.name}: expected at least ${tableManifest.minimumRecordCount}, found ${table?.recordCount ?? "unknown"}`,
      );
    }
  }
  return {
    ok:
      plan.actions.length === 0 &&
      plan.conflicts.length === 0 &&
      recordCountFailures.length === 0,
    plan,
    recordCountFailures,
  };
}
