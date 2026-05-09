/**
 * Parse the ADMIN_EMAILS env var (comma-separated, trimmed, lowercased).
 *
 * Used by setup-account to decide whether a newly-created profile gets
 * `is_admin = true`. See spec §7.2.
 */
export function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  return getAdminEmails().includes(email.toLowerCase());
}
