import type { TaskMaterial } from "@dingjiang/contracts";

/**
 * The single gate for material body text.
 *
 * Body text may leave the server only when the material is marked readable by
 * AI, its extraction finished, and the preview is not blank. Every caller that
 * returns a preview goes through this function: the aggregate context and the
 * single-material preview used to check these conditions in different places,
 * so one of them could drift and leak a body the other refused.
 */
export const exposableContentPreview = (
  file: TaskMaterial["file"],
): string | null => {
  if (!file) return null;
  if (!file.readableByAi) return null;
  if (file.extractionStatus !== "EXTRACTED") return null;
  const preview = file.contentPreview;
  return typeof preview === "string" && preview.trim() ? preview : null;
};
