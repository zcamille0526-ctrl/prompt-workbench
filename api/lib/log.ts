/**
 * Sanitized logging for serverless API endpoints.
 *
 * Goal: never write user-supplied content (API keys, prompt text, message
 * bodies) into Vercel logs. Only metadata about the request and the result.
 *
 * All api/*.ts handlers should use safeLog() instead of plain console output.
 * The CI lint:logs script forbids logging request bodies or message arrays.
 */
type LogContext = {
  endpoint: string;
  method?: string;
  status: number;
  model?: string;
  tokenUsage?: { prompt_tokens: number; completion_tokens: number };
  errorCode?: string;
  durationMs?: number;
};

export function safeLog(ctx: LogContext): void {
  // Single-line JSON to play nicely with Vercel log search.
  console.log(JSON.stringify(ctx));
}
