/**
 * Resolve the public-facing site URL used in invite email redirects.
 *
 * Production: SITE_URL env var (e.g. https://prompt-workbench-three.vercel.app).
 * Preview: VERCEL_URL is auto-injected by Vercel (without scheme), used as
 *   fallback so feature-branch deployments produce working invite links.
 * Local: SITE_URL must be set in .env.local (no fallback).
 *
 * Throws on missing config so signup / resend-invite fail loudly rather than
 * silently emailing a broken redirect.
 */
export function getSiteUrl(): string {
  const explicit = process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  throw new Error("Missing SITE_URL (and no VERCEL_URL fallback)");
}

export function getCallbackUrl(): string {
  return `${getSiteUrl()}/auth/callback`;
}
