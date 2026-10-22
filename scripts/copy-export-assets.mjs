import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = join(root, "dist/export/runtime-config.ts");
await mkdir(dirname(runtime), { recursive: true });
await copyFile(join(root, "src/export/runtime-config.ts"), runtime);
await chmod(join(root, "dist/cli.js"), 0o755);
