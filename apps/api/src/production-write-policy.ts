import { isProduction } from "./runtime-config";
/** Temporary release safety latch, not a substitute for human business approval.
 * Keep disabled until every P0 item in handoff/PRODUCTION_RISKS.md is closed. */
export function productionWritesEnabled(): boolean {
  return (
    !isProduction() ||
    (process.env.DINGJIANG_PRODUCTION_WRITES === "enabled" &&
      /^ACCEPTED-[A-Za-z0-9_-]{8,120}$/.test(
        process.env.DINGJIANG_WRITE_ACCEPTANCE_REF ?? "",
      ))
  );
}
