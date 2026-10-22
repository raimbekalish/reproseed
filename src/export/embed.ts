import { ExportError } from "./export-error.ts";

/**
 * Returns a JavaScript expression that evaluates to `value`.
 * Scenario strings are JSON text inside a string literal, not raw source text.
 */
export function embedJson(value: unknown): string {
  const json = JSON.stringify(value, replacer);
  if (json === undefined) {
    throw new ExportError("cannot serialize scenario data");
  }
  const escaped = json.replace(/[&<>\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const expression = `JSON.parse(${JSON.stringify(escaped)})`;
  if (expression.includes("\n") || expression.includes("\r")) {
    throw new ExportError("embedded scenario data must be a single line");
  }
  return expression;
}

function replacer(key: string, item: unknown): unknown {
  if (item === undefined) {
    throw new ExportError(`cannot serialize undefined at ${key === "" ? "the scenario" : key}`);
  }
  if (typeof item === "number" && !Number.isFinite(item)) {
    throw new ExportError(`cannot serialize a non-finite number at ${key}`);
  }
  if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
    throw new ExportError(`cannot serialize ${typeof item}`);
  }
  return item;
}
