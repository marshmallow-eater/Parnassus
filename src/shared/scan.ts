import {
  MAX_FILE_SIZE,
  isJunkPath,
  matchGitignore,
  parseGitignore,
  sniffClass,
} from "./classify";
import { PROFILE_DIR } from "./profile";
import type { DeepDir, Project, ScanResult, ScannedFile, SkippedItem } from "./types";

// The scan algorithm is written once, here, over a small source interface.
// The real bridge backs the source with node:fs, the mock with its in-memory
// tree, so both classify and skip identically.
export interface ScanSource {
  // Top-level entries of the project folder.
  listTop(): Promise<{ name: string; isDir: boolean; size: number }[]>;
  // First bytes of a file, for content sniffing.
  readHead(relPath: string): Promise<Uint8Array>;
  readText(relPath: string): Promise<string | null>;
  // Recursive file count and total size inside a top-level directory.
  dirStats(relDir: string): Promise<{ fileCount: number; size: number }>;
}

export async function runScan(source: ScanSource, project: Project): Promise<ScanResult> {
  const top = await source.listTop();
  const gitignoreText = await source.readText(".gitignore");
  const patterns = gitignoreText ? parseGitignore(gitignoreText) : [];

  const files: ScannedFile[] = [];
  const skipped: SkippedItem[] = [];
  const deepDirs: DeepDir[] = [];

  for (const entry of top) {
    // Parnassus's own metadata folder (goal/soul files) is not project
    // content: it is never listed as a file, a skip, or a subfolder.
    if (entry.name === PROFILE_DIR) continue;
    if (entry.isDir) {
      const stats = await source.dirStats(entry.name);
      if (isJunkPath(entry.name)) {
        skipped.push({
          path: entry.name,
          reason: "junk",
          fileClass: "directory",
          size: stats.size,
          isDir: true,
        });
      } else {
        deepDirs.push({ path: entry.name, fileCount: stats.fileCount });
      }
      continue;
    }
    const head = await source.readHead(entry.name);
    const fileClass = sniffClass(head);
    if (isJunkPath(entry.name)) {
      skipped.push({ path: entry.name, reason: "junk", fileClass, size: entry.size, isDir: false });
    } else if (matchGitignore(patterns, entry.name)) {
      skipped.push({
        path: entry.name,
        reason: "gitignore",
        fileClass,
        size: entry.size,
        isDir: false,
      });
    } else if (entry.size > MAX_FILE_SIZE) {
      skipped.push({ path: entry.name, reason: "size", fileClass, size: entry.size, isDir: false });
    } else if (fileClass === "opaque-binary") {
      // Opaque payload is recorded in the manifest when overridden, but it is
      // never copied by default: the agent cannot read or edit it.
      skipped.push({
        path: entry.name,
        reason: "binary",
        fileClass,
        size: entry.size,
        isDir: false,
      });
    } else {
      files.push({ path: entry.name, fileClass, size: entry.size });
    }
  }

  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  files.sort(byPath);
  skipped.sort(byPath);
  deepDirs.sort(byPath);
  return { project, files, skipped, deepDirs };
}
