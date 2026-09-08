import { FeishuReviewGateway } from "../experience-intelligence/feishu/feishu-review.gateway";

const requiredEnvironment = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const main = async () => {
  const gateway = new FeishuReviewGateway({
    mode: "FEISHU",
    appId: requiredEnvironment("FEISHU_APP_ID"),
    appSecret: requiredEnvironment("FEISHU_APP_SECRET"),
    baseAppToken: requiredEnvironment("FEISHU_BASE_APP_TOKEN"),
    reviewTableId: requiredEnvironment("FEISHU_REVIEW_TABLE_ID"),
  });

  const items = await gateway.pullReviewDecisions();

  process.stdout.write(
    `${JSON.stringify({
      status: "PASS",
      operation: "FEISHU_REVIEW_READ",
      records: items.length,
      providers: [...new Set(items.map((item) => item.provider))],
      secretsEmitted: false,
    })}\n`,
  );
};

void main();
