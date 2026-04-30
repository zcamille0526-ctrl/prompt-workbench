import { describe, it, expect } from "vitest";
import { extractVariables, substituteVariables } from "../../src/lib/variables";

describe("extractVariables", () => {
  it("extracts variable names from content", () => {
    const result = extractVariables("请梳理{{学科}}{{年级}}的知识点");
    expect(result).toEqual(["学科", "年级"]);
  });

  it("returns empty array for no variables", () => {
    const result = extractVariables("没有变量的文本");
    expect(result).toEqual([]);
  });

  it("deduplicates variable names", () => {
    const result = extractVariables("{{x}} and {{x}} again");
    expect(result).toEqual(["x"]);
  });
});

describe("substituteVariables", () => {
  it("replaces variables with values", () => {
    const result = substituteVariables("请梳理{{学科}}{{年级}}的知识点", {
      学科: "语文",
      年级: "八年级",
    });
    expect(result).toBe("请梳理语文八年级的知识点");
  });

  it("leaves unmatched variables as-is", () => {
    const result = substituteVariables("{{a}} and {{b}}", { a: "hello" });
    expect(result).toBe("hello and {{b}}");
  });

  it("handles empty values map", () => {
    const result = substituteVariables("{{x}}", {});
    expect(result).toBe("{{x}}");
  });
});
