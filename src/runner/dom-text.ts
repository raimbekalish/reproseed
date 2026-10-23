/**
 * DOM text comparison rule.
 *
 * The runner reads the single matched element's `textContent` through Playwright's
 * locator API. It does not read `innerHTML`, and the scenario cannot supply a script.
 * Hidden descendant text is included because `textContent` does not depend on layout.
 *
 * Both sides are normalized before comparison:
 * non-breaking spaces become regular spaces, each whitespace run becomes one space,
 * and the ends are trimmed. The comparison is then exact string equality.
 *
 * The failure signature stores the selector, the normalized expected text, and the
 * normalized actual text. A different actual string is a different failure.
 * Zero matches, multiple matches, a detached element, and an invalid selector are
 * runner errors. They are not DOM_MISMATCH.
 *
 * This file is embedded in generated Playwright specs, so it must stay free of imports.
 */

export function normalizeDomText(value: string): string {
  return value.replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim();
}

export function domTextsMatch(actual: string, expected: string): boolean {
  return normalizeDomText(actual) === normalizeDomText(expected);
}
