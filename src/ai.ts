import type { Workspace } from "./board";

export type AiSettings = { baseUrl: string; model: string; apiKey: string };
export type AgentResult = { workspace: Workspace; revision: string; canUndo: boolean; command: string };
export type AiProposal = { action: unknown; revision: string };

// Presets are editable examples; availability and pricing belong to providers.
export const AI_PRESETS = {
  custom: { baseUrl: "", model: "" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  bigmodel: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
} as const;
