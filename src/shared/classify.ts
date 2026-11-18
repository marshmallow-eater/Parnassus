import type { FileClass } from "./types";

// Files larger than this are skipped at scan time unless the user overrides
// the skip. The limit is a scan default, not a hard cap on what the app can
// hold.
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

const READABLE_MAGICS: { bytes: number[]; offset?: number }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP: office docs, epub, jars
  { bytes: [0x49, 0x44, 0x33] }, // ID3 (mp3 with tag)
  { bytes: [0xff, 0xfb] }, // MP3 frame sync
  { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF: WAV, WebP, AVI
  { bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS: ogg audio and video
];

const OPAQUE_MAGICS: { bytes: number[]; offset?: number }[] = [
  { bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF executable or library
  { bytes: [0x4d, 0x5a] }, // MZ: Windows PE executable or DLL
  { bytes: [0xfe, 0xed, 0xfa, 0xce] }, // Mach-O 32
  { bytes: [0xfe, 0xed, 0xfa, 0xcf] }, // Mach-O 64
  { bytes: [0xcf, 0xfa, 0xed, 0xfe] }, // Mach-O 64, reverse byte order
  { bytes: [0x00, 0x61, 0x73, 0x6d] }, // WebAssembly module
  { bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Java class file
  { bytes: [0x27, 0x05, 0x19, 0x56] }, // SQLite database
];

function hasMagic(head: Uint8Array, magic: { bytes: number[]; offset?: number }): boolean {
  const offset = magic.offset ?? 0;
  if (head.length < offset + magic.bytes.length) return false;
  return magic.bytes.every((b, i) => head[offset + i] === b);
}

// Classifies a file from its first bytes. Readable formats the agent can use
// (images, PDFs, office docs, audio) are matched by magic bytes first. Known
// executable and database formats are opaque. Anything else falls to the
// null-byte heuristic git uses: a NUL in the sample means binary, and a
// binary with no readable magic is opaque.
export function sniffClass(head: Uint8Array): FileClass {
  for (const magic of READABLE_MAGICS) {
    if (hasMagic(head, magic)) return "readable-binary";
  }
  for (const magic of OPAQUE_MAGICS) {
    if (hasMagic(head, magic)) return "opaque-binary";
  }
  const sample = head.subarray(0, 8192);
  for (const byte of sample) {
    if (byte === 0) return "opaque-binary";
  }
  return "text";
}

const JUNK_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "__pycache__",
  "coverage",
  ".turbo",
]);

const JUNK_FILES = new Set([".DS_Store", "Thumbs.db"]);

// True when any path segment is a directory whose contents never belong in a
// copy-in: VCS internals, dependency trees, build outputs, caches.
export function isJunkPath(relPath: string): boolean {
  const parts = relPath.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (JUNK_DIRS.has(part)) return true;
  }
  const base = parts[parts.length - 1];
  return base !== undefined && JUNK_FILES.has(base);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${withStars}$`);
}

// Minimal gitignore matching, enough for the patterns people actually write:
// "*.log", "name", "dir/", "/anchored", "a/b.txt". Negations and character
// classes are not supported; a pattern that needs them simply will not match
// here, and the user still sees the file in the included list.
export function matchGitignore(patterns: string[], relPath: string): boolean {
  const path = relPath.replace(/^\//, "");
  const base = path.split("/").pop() ?? path;
  for (const raw of patterns) {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#") || pattern.startsWith("!")) continue;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    const hasSlash = pattern.includes("/");
    const re = globToRegExp(pattern);
    if (dirOnly) {
      const segments = path.split("/");
      if (segments.some((seg) => re.test(seg))) return true;
      continue;
    }
    if (anchored || hasSlash) {
      if (re.test(path)) return true;
    } else {
      if (re.test(base) || re.test(path)) return true;
    }
  }
  return false;
}

export function parseGitignore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// FNV-1a hash, hex encoded. Used by the mock bridge, where hashes only need
// to be stable enough for equality checks. The real bridge uses SHA-256.
export function fnvHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
