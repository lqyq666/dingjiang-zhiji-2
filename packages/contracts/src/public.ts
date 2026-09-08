import { z } from "zod";

export * from "./vs01";
export * from "./vs12";
export * from "./vs16";
export * from "./vs17";
export * from "./vs18";
export * from "./integration";
export * from "./work-execution";
export * from "./governed-command";
export * from "./workpaper-proposal";
export * from "./material-create";
export * from "./material-verification";
export * from "./evidence-intake";

export const healthResponseSchema = z.object({
  service: z.enum(["api", "ml-service", "web"]),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
