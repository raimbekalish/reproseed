import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const exportDir = join(root, "dist/export");
await mkdir(exportDir, { recursive: true });
await copyFile(join(root, "src/export/runtime-config.ts"), join(exportDir, "runtime-config.ts"));
await copyFile(join(root, "src/runner/delay-match.ts"), join(exportDir, "delay-match.ts"));
await copyFile(join(root, "src/runner/dom-text.ts"), join(exportDir, "dom-text.ts"));
await chmod(join(root, "dist/cli.js"), 0o755);
