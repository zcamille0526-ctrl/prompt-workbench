export const MODELS = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4-Flash（快速）",
    description: "响应快，适合日常对话和简单任务",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4-Pro（推理强）",
    description: "推理能力更强，适合复杂任务",
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export const DEFAULT_MODEL: ModelId = "deepseek-v4-flash";
