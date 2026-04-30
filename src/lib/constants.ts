export const CATEGORIES = ["生图", "生文", "分析", "开发", "元提示词"] as const;

export type Category = (typeof CATEGORIES)[number];

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "";
