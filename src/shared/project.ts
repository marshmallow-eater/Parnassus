import { fnvHash } from "./classify";
import type { Project } from "./types";

// Derives the stable project record for a folder path. Both bridges use it
// so a folder maps to the same project id everywhere.
export function projectFromPath(rootPath: string): Project {
  const name = rootPath.split("/").filter((p) => p.length > 0).pop() ?? rootPath;
  const id = `p-${fnvHash(new TextEncoder().encode(rootPath))}`;
  return { id, name, rootPath };
}
