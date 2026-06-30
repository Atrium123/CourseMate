export type AiModelId = "deepseek-v4-flash" | "deepseek-v4-pro";

export interface AiModelOption {
  id: AiModelId;
  label: string;
  description: string;
}

export const aiModelOptions: AiModelOption[] = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "速度更快，适合快速生成课程目录和常规讲解。",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "能力更强，适合复杂资料、长上下文和更细致的追问。",
  },
];

export const defaultAiModelId: AiModelId = "deepseek-v4-flash";

export function isAiModelId(value: unknown): value is AiModelId {
  return aiModelOptions.some((model) => model.id === value);
}

export function normalizeAiModelId(value: unknown): AiModelId {
  return isAiModelId(value) ? value : defaultAiModelId;
}

export function getAiModelLabel(modelId: AiModelId) {
  return aiModelOptions.find((model) => model.id === modelId)?.label ?? modelId;
}
