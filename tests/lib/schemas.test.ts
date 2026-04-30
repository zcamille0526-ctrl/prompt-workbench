import { describe, it, expect } from "vitest";
import { PromptSchema, VariableSchema } from "../../src/lib/schemas";

describe("VariableSchema", () => {
  it("accepts valid variable", () => {
    const result = VariableSchema.safeParse({ name: "学科", default: "语文" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = VariableSchema.safeParse({ name: "", default: "" });
    expect(result.success).toBe(false);
  });

  it("accepts variable without default", () => {
    const result = VariableSchema.safeParse({ name: "年级" });
    expect(result.success).toBe(true);
  });
});

describe("PromptSchema", () => {
  it("accepts valid prompt", () => {
    const result = PromptSchema.safeParse({
      title: "测试提示词",
      content: "请梳理{{学科}}的知识点",
      category: "生文",
      tags: ["教育"],
      variables: [{ name: "学科", default: "语文" }],
      created_by: "张三",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing title", () => {
    const result = PromptSchema.safeParse({
      title: "",
      content: "内容",
      category: "生文",
      tags: [],
      variables: [],
      created_by: "张三",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing created_by", () => {
    const result = PromptSchema.safeParse({
      title: "标题",
      content: "内容",
      category: "生文",
      tags: [],
      variables: [],
      created_by: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate variable names", () => {
    const result = PromptSchema.safeParse({
      title: "标题",
      content: "{{x}} {{x}}",
      category: "生文",
      tags: [],
      variables: [{ name: "x" }, { name: "x" }],
      created_by: "张三",
    });
    expect(result.success).toBe(false);
  });
});
