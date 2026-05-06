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
};

// POST schema: includes created_by (the new owner is the current user's name)
export const PromptCreateSchema = z
  .object({
    ...promptCommonShape,
    created_by: z.string().min(1, "创建人不能为空"),
  })
  .strict()
  .refine(dedupVariables, dedupMessage);

// PUT schema: omits created_by (owner is immutable; any attempt to change it returns 400)
export const PromptUpdateSchema = z
  .object(promptCommonShape)
  .strict()
  .refine(dedupVariables, dedupMessage);

export type PromptCreateInput = z.infer<typeof PromptCreateSchema>;
export type PromptUpdateInput = z.infer<typeof PromptUpdateSchema>;

// Backwards-compatible alias for existing form code that submits new prompts.
// The form supplies created_by from sessionStorage so it always matches the
// create-shape; for edit it strips created_by before submitting (see PromptForm).
export const PromptSchema = PromptCreateSchema;
export type PromptInput = PromptCreateInput;

export interface Prompt {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  variables: Variable[];
  created_by: string;
  created_at: string;
  updated_at: string;
}
