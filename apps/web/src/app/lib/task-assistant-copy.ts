export const taskAssistantCoverageSummary = (coverage: {
  evidenceCount: number;
  materialCount: number;
  materialGapCount: number;
}) =>
  `已读取 ${coverage.evidenceCount} 条证据 · ${coverage.materialCount} 项材料 · ${coverage.materialGapCount} 项材料缺口`;
