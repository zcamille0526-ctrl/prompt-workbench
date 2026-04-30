import { z } from "zod";

export const VariableSchema = z.object({
  name: z.string().min(1, "变量名不能为空"),
  default: z.string().optional(),
});

export type Variable = z.infer<typeof VariableSchema>;

export const PromptSchema = z
  .object({
    title: z.string().min(1, "标题不能为空"),
    content: z.string().min(1, "内容不能为空"),
    category: z.string().min(1, "请选择分类"),
    tags: z.array(z.string()),
    variables: z.array(VariableSchema),
    created_by: z.string().min(1, "创建人不能为空"),
  })
  .refine(
    (data) => {
      const names = data.variables.map((v) => v.name);
      return new Set(names).size === names.length;
    },
    { message: "变量名不能重复" }
  );

export type PromptInput = z.infer<typeof PromptSchema>;

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
