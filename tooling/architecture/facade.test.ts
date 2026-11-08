import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const facadePath = join(repositoryRoot, "apps/api/src/vs01.service.ts");

/**
 * Lifecycle and transaction plumbing are the only methods allowed to touch the
 * pool directly: startup has to check the schema, shutdown has to close it,
 * and inCommandTransaction has to hand the caller's client to a bound instance.
 * Every other method is a business method and belongs in a collaborator.
 */
const plumbingMethods = new Set([
  "onModuleInit",
  "onModuleDestroy",
  "inCommandTransaction",
]);

const collaborators = [
  "readModel",
  "lifecycle",
  "experienceService",
  "assistant",
  "decisions",
  "materials",
] as const;

const sqlKeyword = /\b(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i;
const rawQueryCalls = new Set(["query", "connect", "release", "end"]);

/**
 * SQL can sit in any chunk of a template literal, not just its head: in
 * `note ${id} SELECT 1` the keyword is in the tail. Checking only the head
 * would let a hand-built query through.
 */
const sqlLiterals = (node: ts.Node): string[] => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text];
  if (ts.isTemplateExpression(node))
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ];
  return [];
};

interface MethodShape {
  name: string;
  delegates: boolean;
  violations: string[];
}

interface FacadeShape {
  methods: MethodShape[];
  usedCollaborators: Set<string>;
}

const inspectFacade = (text: string): FacadeShape => {
  const source = ts.createSourceFile(
    "facade.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const facadeClass = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === "Vs01Service",
  );
  if (!facadeClass) throw new Error("vs01.service.ts 里找不到 Vs01Service 类");

  const methods: MethodShape[] = [];
  const usedCollaborators = new Set<string>();

  for (const member of facadeClass.members) {
    if (!ts.isMethodDeclaration(member) || !member.body) continue;
    const name = member.name.getText(source);
    if (plumbingMethods.has(name)) continue;

    let delegates = false;
    const violations = new Set<string>();

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const callee = node.expression;
        const receiver = callee.expression;
        if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
          // this.method(): a facade method delegating through another one.
          delegates = true;
        } else if (
          ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const owner = receiver.name.text;
          if (owner === "database" || owner === "pool") {
            // Talking to the pool is not delegation. Do not let it satisfy the
            // "method delegates" check while still adding a violation.
            violations.add(`直接访问 this.${owner}`);
          } else {
            // this.service.method(): the shape every business method should have.
            delegates = true;
            usedCollaborators.add(owner);
          }
        }
        if (rawQueryCalls.has(callee.name.text))
          violations.add(`直接调用 .${callee.name.text}()`);
      }

      for (const literal of sqlLiterals(node))
        if (sqlKeyword.test(literal))
          violations.add(`SQL 字面量：${literal.slice(0, 48)}`);

      ts.forEachChild(node, visit);
    };

    visit(member.body);
    methods.push({ name, delegates, violations: [...violations] });
  }

  return { methods, usedCollaborators };
};

describe("the vs01 facade only delegates", () => {
  it("notices SQL and local domain logic when they land in a facade method", () => {
    const { methods } = inspectFacade(`
      class Vs01Service {
        async clean(id: string) { return this.readModel.project(id); }
        async leaky(id: string) {
          await this.database.query("SELECT 1", [id]);
          return this.readModel.project(id);
        }
        async spanSql(id: string) {
          const note = \`note \${id} SELECT 1\`;
          return this.readModel.project(note);
        }
        async poolOnly() { return this.database.query("SELECT 1"); }
        async localOnly(id: string) { return id.trim(); }
      }
    `);
    const byName = (name: string) =>
      methods.find((method) => method.name === name);

    expect(byName("clean")).toMatchObject({
      delegates: true,
      violations: [],
    });
    expect(byName("leaky")?.violations.length).toBeGreaterThanOrEqual(2);
    expect(byName("localOnly")?.delegates).toBe(false);

    // A keyword in a template tail must be caught even when the method does
    // delegate properly; touching the pool must never count as delegation.
    expect(byName("spanSql")).toMatchObject({ delegates: true });
    expect(byName("spanSql")?.violations.length).toBeGreaterThan(0);
    expect(byName("poolOnly")?.delegates).toBe(false);
    expect(byName("poolOnly")?.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps SQL and domain logic out of every business method", async () => {
    const shape = inspectFacade(await readFile(facadePath, "utf8"));

    // A parser that finds no methods would let the assertions below pass on an
    // empty array. The facade has ~50 public methods; this is the sanity floor.
    expect(
      shape.methods.length,
      "门面方法数量异常少，可能是 AST 解析失败导致守卫空转。",
    ).toBeGreaterThanOrEqual(40);

    const offenders = shape.methods.flatMap((method) => {
      const problems = [...method.violations];
      if (!method.delegates) problems.push("方法体没有委托给任何协作者");
      return problems.map((problem) => `${method.name}(): ${problem}`);
    });
    expect(
      offenders,
      "门面只负责组装与委托：SQL、事务与领域逻辑必须住在六个协作服务里。\n" +
        offenders.join("\n"),
    ).toEqual([]);

    expect(
      collaborators.filter((name) => !shape.usedCollaborators.has(name)),
      "这些协作者不再被任何门面方法调用：要么它们已经成了死代码，要么有方法绕过了它们。",
    ).toEqual([]);
  });
});
