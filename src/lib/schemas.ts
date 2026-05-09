import { z } from "zod";

export const VariableSchema = z.object({
  name: z.string().min(1, "变量名不能为空"),
  default: z.string().optional(),
});

export type Variable = z.infer<typeof VariableSchema>;

const dedupVariables = (data: { variables: Variable[] }) => {
  const names = data.variables.map((v) => v.name);
  return new Set(names).size === names.length;
};

const dedupMessage = { message: "变量名不能重复" };

const promptCommonShape = {
  title: z.string().min(1, "标题不能为空"),
  content: z.string().min(1, "内容不能为空"),
  category: z.string().min(1, "请选择分类"),
  tags: z.array(z.string()),
  variables: z.array(VariableSchema),
  is_draft: z.boolean().default(false),
};

// Phase 2: created_by_id is filled in server-side from authenticate() —
// schemas no longer accept any kind of owner field from the client. Any
// stray "created_by" / "created_by_id" in the request body must hit the
// strict() rejection so prod can never accept a forged owner.
export const PromptCreateSchema = z
  .object(promptCommonShape)
  .strict()
  .refine(dedupVariables, dedupMessage);

export const PromptUpdateSchema = z
  .object(promptCommonShape)
  .strict()
  .refine(dedupVariables, dedupMessage);

export type PromptCreateInput = z.infer<typeof PromptCreateSchema>;
export type PromptUpdateInput = z.infer<typeof PromptUpdateSchema>;

// Backwards-compatible alias for existing form code that submits new prompts.
export const PromptSchema = PromptCreateSchema;
export type PromptInput = PromptCreateInput;

export interface Prompt {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  variables: Variable[];
  /** UUID of the auth user that created this prompt. */
  created_by_id: string;
  /** display_name resolved from profiles at read time (joined server-side). */
  created_by_name: string;
  created_at: string;
  updated_at: string;
  use_count: number;
  is_draft: boolean;
}

// ---------------------------------------------------------------------------
// Examples — saved test-run conversations attached to a prompt.

export const ExampleMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(20_000),
  })
  .strict();

export const ExampleCreateSchema = z
  .object({
    prompt_id: z.string().uuid(),
    title: z.string().max(100).optional(),
    variable_values: z.record(z.string(), z.string()).default({}),
    model: z.string().min(1).max(64),
    messages: z.array(ExampleMessageSchema).min(2).max(40),
  })
  .strict();

export type ExampleCreateInput = z.infer<typeof ExampleCreateSchema>;

export interface Example {
  id: string;
  prompt_id: string;
  title: string | null;
  variable_values: Record<string, string>;
  model: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  created_by_id: string;
  created_by_name: string;
  created_at: string;
}
