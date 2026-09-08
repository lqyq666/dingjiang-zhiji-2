/** Explicit deployment mode: a Next.js production build alone is not authorization
 * to use production data. The API mode controls database and identity safeguards. */
export const isProduction = (): boolean =>
  process.env.DINGJIANG_DEPLOYMENT_MODE === "production" ||
  (!process.env.DINGJIANG_DEPLOYMENT_MODE &&
    process.env.NODE_ENV === "production");

export const runtimeTenantId = (): string => {
  const value = process.env.DINGJIANG_TENANT_ID?.trim();
  if (!value && !isProduction()) return "tenant-demo";
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/.test(value))
    throw new Error("DINGJIANG_TENANT_ID must identify this enterprise");
  if (isProduction() && value === "tenant-demo")
    throw new Error("Production cannot use the demonstration tenant");
  return value;
};

export const runtimeTargetOtd = (): number => {
  const raw = process.env.DINGJIANG_TARGET_OTD;
  if (!raw && !isProduction()) return 85;
  if (!raw || !/^\d{1,3}$/.test(raw) || Number(raw) > 100)
    throw new Error(
      "DINGJIANG_TARGET_OTD must be an explicit integer from 0 to 100",
    );
  return Number(raw);
};

export const assertProductionConfig = (): void => {
  const mode = process.env.DINGJIANG_DEPLOYMENT_MODE;
  if (mode && mode !== "demo" && mode !== "production")
    throw new Error("DINGJIANG_DEPLOYMENT_MODE must be demo or production");
  if (!isProduction()) return;
  runtimeTenantId();
  runtimeTargetOtd();
  if (
    process.env.DINGJIANG_PRODUCTION_WRITES &&
    !["disabled", "enabled"].includes(process.env.DINGJIANG_PRODUCTION_WRITES)
  )
    throw new Error("DINGJIANG_PRODUCTION_WRITES must be disabled or enabled");
  if (
    process.env.DINGJIANG_PRODUCTION_WRITES === "enabled" &&
    !/^ACCEPTED-[A-Za-z0-9_-]{8,120}$/.test(
      process.env.DINGJIANG_WRITE_ACCEPTANCE_REF ?? "",
    )
  )
    throw new Error(
      "Production writes require an explicit accepted release reference",
    );
  if (!process.env.DATABASE_URL)
    throw new Error("Production requires an explicit DATABASE_URL");
  const origin = process.env.WEB_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(origin ?? "");
  } catch {
    throw new Error("Production requires a HTTPS WEB_ORIGIN");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin)
    throw new Error("Production WEB_ORIGIN must be one exact HTTPS origin");
  if (!process.env.DINGJIANG_COMPANY_NAME?.trim())
    throw new Error("Production requires DINGJIANG_COMPANY_NAME");
  if (
    process.env.DINGJIANG_TRUST_PROXY &&
    !["0", "1"].includes(process.env.DINGJIANG_TRUST_PROXY)
  )
    throw new Error("DINGJIANG_TRUST_PROXY must be 0 or 1");
  if (process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON?.trim())
    throw new Error("Production disables static MCP token bindings");
  if (process.env.DINGJIANG_MCP_API_TOKEN)
    throw new Error(
      "Production requires individual MCP identities; legacy token is disabled",
    );
};
