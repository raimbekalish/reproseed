import { link, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError, EXIT, isNodeError } from "./errors.ts";

const EXTENSION = {
  report: ".json",
  spec: ".ts",
  scenario: ".json",
} as const;

export async function resolveOutputPath(
  cwd: string,
  requested: string,
  kind: keyof typeof EXTENSION,
): Promise<string> {
  if (requested.includes("\0")) {
    throw new CliError("output path contains a null byte", EXIT.usage);
  }
  if (requested.trim() === "" || requested !== requested.trim()) {
    throw new CliError("output path is empty", EXIT.usage);
  }
  const extension = EXTENSION[kind];
  const absolute = resolve(cwd, requested);
  const rel = relative(cwd, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CliError("output path must stay inside the current directory", EXIT.usage);
  }
  if (!absolute.endsWith(extension)) {
    throw new CliError(`${kind} path must end in ${extension}`, EXIT.usage);
  }
  await assertNoOutputSymlink(cwd, rel);
  return absolute;
}

export async function assertCanReplace(path: string, force: boolean): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw new CliError("output path could not be inspected", EXIT.usage);
  }
  if (info.isSymbolicLink()) {
    throw new CliError("refusing to replace a symlink", EXIT.usage);
  }
  if (!info.isFile()) {
    throw new CliError("output path is not a file", EXIT.usage);
  }
  if (!force) {
    throw new CliError(`refusing to overwrite ${path}; pass --force to replace it`, EXIT.usage);
  }
}

/** Creates the parent directory and checks that this process can create a file there. */
export async function ensureOutputDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CliError("output directory is not a real directory", EXIT.usage);
  }
  const probe = join(directory, `.reproseed-write-${process.pid}.probe`);
  try {
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM") || isNodeError(error, "EROFS")) {
      throw new CliError(`cannot write ${directory}`, EXIT.usage);
    }
    throw new CliError("output directory could not be checked", EXIT.internal);
  }
  await unlink(probe);
}

/**
 * Publishes `contents` by writing a temporary file in the same directory, then linking or renaming it.
 * Without `force`, an existing destination is left untouched.
 */
export async function writePublishedFile(path: string, contents: string, force: boolean): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o644 });
    if (!force) {
      try {
        await link(temp, path);
      } catch (error) {
        if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM") || isNodeError(error, "EROFS")) {
          throw new CliError(`cannot write ${path}`, EXIT.internal);
        }
        if (isNodeError(error, "EEXIST")) {
          throw new CliError(`refusing to overwrite ${path}; pass --force to replace it`, EXIT.usage);
        }
        throw error;
      }
      await unlink(temp).catch(() => undefined);
      return;
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof CliError) {
      throw error;
    }
    if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM") || isNodeError(error, "EROFS")) {
      throw new CliError(`cannot write ${path}`, EXIT.internal);
    }
    throw new CliError(error instanceof Error ? error.message : "output could not be written", EXIT.internal);
  }
}

async function assertNoOutputSymlink(cwd: string, rel: string): Promise<void> {
  const segments = rel.split(sep).filter((segment) => segment !== "");
  let cursor = cwd;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw new CliError("output path could not be inspected", EXIT.usage);
    }
    if (info.isSymbolicLink()) {
      throw new CliError("output path must not traverse a symlink", EXIT.usage);
    }
    const last = index === segments.length - 1;
    if (!last && !info.isDirectory()) {
      throw new CliError("output path parent is not a directory", EXIT.usage);
    }
    if (last && info.isDirectory()) {
      throw new CliError("output path is a directory", EXIT.usage);
    }
  }
}
