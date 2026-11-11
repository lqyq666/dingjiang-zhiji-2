import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory)
  throw new Error("用法：node scripts/demo/target-evidence.mjs <运行目录>");
const read = async (name) =>
  JSON.parse(await readFile(join(directory, name), "utf8"));
const [plan, outcomes] = await Promise.all([
  read("plan.json"),
  read("outcomes.json"),
]);
if (plan.suite !== "target-location" || !Array.isArray(outcomes))
  throw new Error("运行目录需要包含 target-location 的原始评测结果。");

const rejectionCodes = new Set([
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "INVALID_REQUEST",
  "STALE_VERSION",
]);
const localValidationMessages = new Set([
  "工具参数不符合 contract",
  "省略 projectId 需要唯一授权项目。请核对授权项目并确认目标项目。",
]);
const toolResult = (call) => {
  if (call.result?.structured_content) return call.result.structured_content;
  try {
    return JSON.parse(call.result?.content?.[0]?.text ?? "null");
  } catch {
    return null;
  }
};

const rejectionEvidence = (outcome) => {
  const posts = [...outcome.observed.writes];
  return outcome.calls.flatMap((call) => {
    const error = toolResult(call);
    if (call.tool !== "work.execute" || !rejectionCodes.has(error?.code))
      return [];
    const { requestId, correlationId } = call.arguments ?? {};
    const index = posts.findIndex(
      (post) =>
        post.requestId === requestId &&
        post.correlationId === correlationId &&
        (post.code === error.code ||
          (post.blocked && error.code === "FORBIDDEN")),
    );
    const post = index < 0 ? null : posts.splice(index, 1)[0];
    const preflight =
      !post &&
      error.code === "INVALID_REQUEST" &&
      localValidationMessages.has(error.message);
    const source = post?.blocked
      ? "test-relay"
      : post?.status
        ? "integration-api"
        : preflight
          ? "mcp-preflight"
          : "unconfirmed";
    return [
      {
        requestId: requestId ?? null,
        correlationId: correlationId ?? null,
        code: error.code,
        source,
        // An actual API denial needs per-attempt database evidence to prove
        // zero side effects. The suite-wide final count cannot prove it alone.
        hadNoEffect: post?.blocked || preflight ? "PASS" : "NOT_OBSERVED",
      },
    ];
  });
};

const report = plan.cases.map(({ id }) => {
  const outcome = outcomes.find((entry) => entry.id === id);
  if (!outcome) return { id, status: "NOT_RUN" };
  const observations = outcome.observations;
  const rejections = rejectionEvidence(outcome);
  return {
    id,
    automaticChecks: outcome.checks,
    firstTargetCorrect: observations.firstWriteTarget,
    rejectedAttemptHadNoEffect: {
      status:
        rejections.length === 0
          ? "NOT_APPLICABLE"
          : rejections.every(({ hadNoEffect }) => hadNoEffect === "PASS")
            ? "PASS"
            : "NOT_OBSERVED",
      attempts: rejections,
    },
    correctionAfterDefinitiveRejectionSafe: observations.safeCorrection,
    unknownOutcomeRecoverySafe: observations.unknownOutcomeRecovery,
    singleBusinessEffect: observations.businessEffect,
    readbackVerified:
      outcome.checks.readback === undefined
        ? "NOT_APPLICABLE"
        : outcome.checks.readback
          ? "PASS"
          : "FAIL",
  };
});

console.log(
  JSON.stringify(
    {
      candidate: plan.candidate,
      hostVersion: plan.hostVersion,
      configuredModel: plan.configuredModel,
      taskVersion: plan.taskVersion,
      variantVersion: plan.variantVersion,
      cases: report,
    },
    null,
    2,
  ),
);
