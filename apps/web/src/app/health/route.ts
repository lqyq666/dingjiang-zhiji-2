import { healthResponseSchema } from "@dingjiang/contracts";

export function GET(): Response {
  return Response.json(
    healthResponseSchema.parse({
      service: "web",
      status: "ok",
    }),
  );
}
