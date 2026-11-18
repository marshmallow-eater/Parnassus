import { fnvHash } from "./classify";
import type { Project } from "./types";

// Derives the stable project record for a folder path. Both bridges use it
// so a folder maps to the same project id everywhere. The folder name is
// split on either separator: rootPath is an OS-native path (backslashes
// on Windows), while every project-relative path inside the app uses "/".
export function projectFromPath(rootPath: string): Project {
  const name = rootPath.split(/[\\/]/).filter((p) => p.length > 0).pop() ?? rootPath;
  const id = `p-${fnvHash(new TextEncoder().encode(rootPath))}`;
  return { id, name, rootPath };
}
