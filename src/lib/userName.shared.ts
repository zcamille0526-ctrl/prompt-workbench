/**
 * Username charset shared by the frontend and backend. Lets users pick a
 * Chinese, English, or mixed-script identity, but blocks anything that could
 * slip through a regex-based comparison (quotes, slashes, wildcards).
 *
 * Both the API's GET viewer param and the frontend's UserNameDialog validate
 * against this same regex — keep them aligned or a name saved in one place
 * will be rejected by the other.
 */
export const USER_NAME_REGEX = /^[\w一-龥 \-]{1,32}$/;

export function isValidUserName(name: string): boolean {
  return USER_NAME_REGEX.test(name);
}
