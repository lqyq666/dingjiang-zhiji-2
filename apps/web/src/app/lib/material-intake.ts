/** A synchronous client seam: the second click is ignored before React can repaint. */
export const createSingleFlightGate = () => {
  let active = false;
  return {
    tryStart: (): boolean => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: (): void => {
      active = false;
    },
  };
};

export const materialReadabilityLabel = (input: {
  kind: "MANUAL_REFERENCE" | "UPLOADED_FILE";
  status: "ACTIVE" | "WITHDRAWN";
  readableByAi?: boolean;
}): string => {
  if (input.status === "WITHDRAWN") return "已停用，不参与当前判断";
  if (input.readableByAi) return "AI 可读取安全摘要";
  if (input.kind === "UPLOADED_FILE") return "需人工查看原文件";
  return "手工来源引用";
};

export const materialVerificationLabel = (
  status: "UNVERIFIED" | "VERIFIED" | "NEEDS_REVISION",
): string =>
  ({
    UNVERIFIED: "待人工核验",
    VERIFIED: "已人工核验",
    NEEDS_REVISION: "需要修订",
  })[status];
