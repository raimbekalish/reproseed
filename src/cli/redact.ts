/** Replaces reset credentials before they can reach the terminal or a file. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
  let next = text;
  for (const secret of unique) {
    if (next.includes(secret)) {
      next = next.split(secret).join("[redacted]");
    }
  }
  return next;
}
