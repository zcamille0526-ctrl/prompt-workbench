export function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  const names = matches.map((m) => m.slice(2, -2));
  return [...new Set(names)];
}

export function substituteVariables(
  content: string,
  values: Record<string, string>
): string {
  return content.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    return name in values ? values[name] : match;
  });
}
