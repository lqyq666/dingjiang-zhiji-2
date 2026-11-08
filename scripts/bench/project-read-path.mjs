#!/usr/bin/env node
/**
 * Reproducible benchmark for the three hot project reads.
 *
 * The index migration in apps/api/migrations/0039_project_read_indexes.sql was
 * written from a measurement, but the measurement itself was not repeatable:
 * it needed a throwaway database, a synthetic data set and three EXPLAIN
 * ANALYZE runs. This script is that measurement, kept.
 *
 * It builds its own database, applies the real migration files, fills them
 * with a synthetic data set of a known shape, then measures each read twice:
 * once with the read-path indexes dropped and once with them in place. The
 * comparison is the point - a single number only shows how fast one machine
 * was on one day.
 *
 * Usage:
 *   node scripts/bench/project-read-path.mjs
 *   node scripts/bench/project-read-path.mjs --keep     # leave the database behind
 *   DATABASE_URL=postgres://... node scripts/bench/project-read-path.mjs
 *
 * It needs a reachable PostgreSQL and nothing else: no model credential, no
 * Feishu app, no network access beyond loopback.
 */
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const apiDir = join(root, "apps/api");
const migrationsDir = join(apiDir, "migrations");
// `pg` is a dependency of the API package, not of the repository root.
const pg = createRequire(join(apiDir, "package.json"))("pg");

const DEFAULT_DATABASE_URL =
  "postgres://dingjiang:local-only-password@127.0.0.1:5432/dingjiang";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const keepDatabase = process.argv.includes("--keep");

const TENANT = "tenant-demo";
const PROJECTS = 300;
const SUBTASKS_PER_PROJECT = 336;
const EVENTS_PER_PROJECT = 667;
const MATERIALS_PER_TASK = 667;

const READ_PATH_INDEXES = [
  {
    name: "vs01_project_subtasks_phase_idx",
    table: "vs01_project_subtasks",
    columns: ["tenant_id", "node_id", "phase_code"],
  },
  {
    name: "vs01_project_events_timeline_idx",
    table: "vs01_project_events",
    columns: ["tenant_id", "project_id", "id"],
  },
  {
    name: "vs01_task_materials_task_idx",
    table: "vs01_task_materials",
    columns: ["tenant_id", "task_id", "created_at", "id"],
  },
];

const READS = [
  {
    label: "subtask phase count",
    note: "每次阶段推进要问两三次，成本按用户操作付，不按页面付",
    sql: "SELECT count(*) FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = $3",
    values: [TENANT, "BENCH-NODE-1", "EXECUTION_CONTROL"],
  },
  {
    label: "project event timeline",
    note: "按 id 稳定排序",
    sql: "SELECT id, event_type, created_at FROM vs01_project_events WHERE tenant_id = $1 AND project_id = $2 ORDER BY id",
    values: [TENANT, "BENCH-PRJ-1"],
  },
  {
    label: "task material list",
    note: "按创建时间与 id 排序",
    sql: "SELECT id, title, created_at FROM vs01_task_materials WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at, id",
    values: [TENANT, "BENCH-TASK-1"],
  },
];

const applyMigrations = async (pool) => {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
  return files.length;
};

const fill = async (pool) => {
  await pool.query(
    "INSERT INTO vs01_source_objects(id, tenant_id, file_name) VALUES ('BENCH-SRC', $1, 'bench.csv') ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    "INSERT INTO vs01_source_versions(id, source_object_id, tenant_id, version_number) VALUES ('BENCH-SRC-V1', 'BENCH-SRC', $1, 1) ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    `INSERT INTO vs01_orders(order_id, tenant_id, customer, promised_date, forecast_date, status, source_row, source_version_id)
     SELECT 'BENCH-ORD-' || g, $1, 'bench customer', current_date, current_date + 5, 'OPEN', g + 1, 'BENCH-SRC-V1'
     FROM generate_series(1, $2) g`,
    [TENANT, PROJECTS],
  );
  await pool.query(
    `INSERT INTO vs01_tasks(id, tenant_id, order_id, status)
     SELECT 'BENCH-TASK-' || g, $1, 'BENCH-ORD-' || g, 'OPEN' FROM generate_series(1, $2) g`,
    [TENANT, PROJECTS],
  );
  await pool.query(
    `INSERT INTO vs01_projects(id, tenant_id, source_task_id, name, status, metric_before, metric_current, metric_target)
     SELECT 'BENCH-PRJ-' || g, $1, 'BENCH-TASK-' || g, 'Bench project ' || g, 'RUNNING', 70, 80, 85
     FROM generate_series(1, $2) g`,
    [TENANT, PROJECTS],
  );
  await pool.query(
    `INSERT INTO vs01_project_nodes(id, tenant_id, project_id, name, status, progress, latest_update)
     SELECT 'BENCH-NODE-' || p, $1, 'BENCH-PRJ-' || p, 'Node', 'IN_PROGRESS', 50, 'bench'
     FROM generate_series(1, $2) p`,
    [TENANT, PROJECTS],
  );
  await pool.query(
    `INSERT INTO vs01_project_subtasks(id, tenant_id, node_id, title, status, sort_order, phase_code, owner, origin, inputs, process, expected_output, acceptance)
     SELECT 'BENCH-SUB-' || p || '-' || s, $1, 'BENCH-NODE-' || p, 'Subtask ' || s, 'DONE', s, 'EXECUTION_CONTROL', 'PMC', 'LIVE', '[]'::jsonb, '{}'::jsonb, 'bench output', '{}'::jsonb
     FROM generate_series(1, $2) p, generate_series(1, $3) s`,
    [TENANT, PROJECTS, SUBTASKS_PER_PROJECT],
  );
  await pool.query(
    `INSERT INTO vs01_project_events(tenant_id, project_id, event_type, phase_code, note, actor, created_at, snapshot)
     SELECT $1, 'BENCH-PRJ-' || p, 'TASK_COMPLETED', 'EXECUTION_CONTROL', 'bench', 'PMC', now(), '{}'::jsonb
     FROM generate_series(1, $2) p, generate_series(1, $3) e`,
    [TENANT, PROJECTS, EVENTS_PER_PROJECT],
  );
  await pool.query(
    `INSERT INTO vs01_task_materials(tenant_id, task_id, situation_code, title, source_reference, note, created_by, created_at, kind, status)
     SELECT $1, 'BENCH-TASK-' || t, 'BOM_DELAY', 'Material ' || m, 'bench ref', 'bench note', 'PMC', now(), 'MANUAL_REFERENCE', 'ACTIVE'
     FROM generate_series(1, $2) t, generate_series(1, $3) m`,
    [TENANT, PROJECTS, MATERIALS_PER_TASK],
  );
  await pool.query("ANALYZE");
};

const dropReadPathIndexes = async (pool) => {
  for (const index of READ_PATH_INDEXES)
    await pool.query(`DROP INDEX IF EXISTS ${index.name}`);
};

const createReadPathIndexes = async (pool) => {
  for (const index of READ_PATH_INDEXES)
    await pool.query(
      `CREATE INDEX ${index.name} ON ${index.table} (${index.columns.join(", ")})`,
    );
};

/** Run a read under EXPLAIN (ANALYZE) three times and keep the fastest. */
const measure = async (pool, read) => {
  const timings = [];
  let plan = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS) ${read.sql}`,
      read.values,
    );
    const lines = result.rows.map((row) => row["QUERY PLAN"]);
    plan = lines.join("\n");
    const match = plan.match(/Execution Time: ([\d.]+) ms/);
    if (match) timings.push(Number(match[1]));
  }
  const scan = plan.includes("Seq Scan") ? "Seq Scan" : "Index Scan";
  return {
    label: read.label,
    note: read.note,
    scan,
    milliseconds: timings.length ? Math.min(...timings) : Number.NaN,
    plan: plan.split("\n").slice(0, 2).join(" | "),
  };
};

const main = async () => {
  const databaseName = `dingjiang_bench_${process.pid}_${Date.now()}`;
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const adminPool = new pg.Pool({ connectionString: admin.toString() });
  const target = new URL(databaseUrl);
  target.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: target.toString() });

  try {
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    const applied = await applyMigrations(pool);
    console.log(`数据库 ${databaseName} 已建立，应用 ${applied} 个迁移文件`);

    await fill(pool);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM vs01_projects) AS projects,
         (SELECT count(*) FROM vs01_project_subtasks) AS subtasks,
         (SELECT count(*) FROM vs01_project_events) AS events,
         (SELECT count(*) FROM vs01_task_materials) AS materials`,
    );
    const c = counts.rows[0];
    console.log(
      `数据规模：${c.projects} 项目 / ${c.subtasks} 子任务 / ${c.events} 事件 / ${c.materials} 材料\n`,
    );

    await dropReadPathIndexes(pool);
    const without = [];
    for (const read of READS) without.push(await measure(pool, read));

    await createReadPathIndexes(pool);
    const with_ = [];
    for (const read of READS) with_.push(await measure(pool, read));

    console.log("| 读路径 | 无索引 | 有索引 | 计划变化 | 提升 |");
    console.log("| --- | --- | --- | --- | --- |");
    for (let index = 0; index < READS.length; index += 1) {
      const before = without[index];
      const after = with_[index];
      const factor =
        before.milliseconds > 0
          ? `${(before.milliseconds / after.milliseconds).toFixed(0)}x`
          : "-";
      console.log(
        `| ${before.label} | ${before.milliseconds.toFixed(3)} ms (${before.scan}) | ${after.milliseconds.toFixed(3)} ms (${after.scan}) | ${before.scan} → ${after.scan} | ${factor} |`,
      );
    }
    console.log("");
    for (const entry of with_) console.log(`· ${entry.label}：${entry.note}`);
    console.log(
      "\n注：每个读路径跑三次取最快值；机器、缓存与并发都会影响绝对数字，可复现的是同一台机器上的前后对比。",
    );
  } finally {
    await pool.end().catch(() => undefined);
    await adminPool
      .query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      )
      .catch(() => undefined);
    if (!keepDatabase)
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${databaseName}`)
        .catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    if (keepDatabase) console.log(`\n数据库 ${databaseName} 已保留`);
  }
};

await main();
