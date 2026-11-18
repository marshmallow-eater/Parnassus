// Types shared by the Electron main process, the preload bridge, and the
// renderer. Everything in this file must stay serializable: it crosses the
// IPC boundary as plain JSON.

export type FileClass = "text" | "readable-binary" | "opaque-binary";

export type SkipReason = "binary" | "junk" | "size" | "gitignore" | "deep";

export type SyncState = "in-sync" | "local-changed" | "muse-changed" | "conflict";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  // The project's own stated goal and agent soul. Null (or absent) means
  // "same as generic": the generic value applies until the user updates
  // the field for this project.
  goal?: string | null;
  soul?: string | null;
  // The muse.ai thread URL bound to this project's isolated chat, set
  // only once a thread started for this project becomes a real
  // conversation. Null/absent means start a new thread on open. (The
  // pre-isolation `chatUrl` field, if present in old stored records, is
  // ignored: it named whatever conversation happened to be selected.)
  isolatedChatUrl?: string | null;
  // Absolute folder holding this project's staged (Muse-side) copies:
  // <storage>/projects/<id>/staged in the real bridge. Populated by the
  // bridges on return, so the UI can point the chat at it.
  stagedPath?: string;
}

// What the agent is for (goal) and how it should be (soul). The generic
// profile is the default every project inherits from.
export interface AgentProfile {
  goal: string;
  soul: string;
}

// The project's recorded decisions and internal knowledge, stored as
// markdown in .parnassus/decisions.md and .parnassus/memory.md. Null
// means the file does not exist yet.
export interface ProjectKnowledge {
  decisions: string | null;
  memory: string | null;
}

// One file in the manifest written at copy-in time. The manifest is the base
// of the three-way check: local files are one head, the staged Muse-side
// copies are the other.
export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface ScannedFile {
  path: string;
  fileClass: FileClass;
  size: number;
}

// A file or a whole directory subtree that the scan did not include. Skips
// are always shown to the user with their reason and can be overridden.
export interface SkippedItem {
  path: string;
  reason: SkipReason;
  // "directory" for subtree skips (junk directories), where a single file
  // class does not apply.
  fileClass: FileClass | "directory";
  size: number;
  isDir: boolean;
}

// A non-junk subdirectory. Shallow scan lists these but does not copy or
// descend into them until the user asks.
export interface DeepDir {
  path: string;
  fileCount: number;
}

export interface ScanResult {
  project: Project;
  files: ScannedFile[];
  skipped: SkippedItem[];
  deepDirs: DeepDir[];
}

export interface FileState {
  path: string;
  state: SyncState;
}

export interface ReconcileResult {
  projectId: string;
  state: SyncState;
  files: FileState[];
}

export interface SaveBackOutcome {
  written: string[];
  keptLocal: string[];
  blocked: string[];
  result: ReconcileResult;
}

// One copied-in file as the context pack describes it to a chat: name,
// kind, size, and for text files a short opening excerpt. Opaque and
// readable binaries get no excerpt; the chat only learns that they exist.
export interface ContextFile {
  path: string;
  fileClass: FileClass;
  size: number;
  excerpt: string | null;
}

// Which way one file moves when the user approves the sync review.
export type SyncDirection = "to-local" | "to-muse";

export interface SyncOutcome {
  appliedToLocal: string[];
  appliedToMuse: string[];
  blocked: string[];
  result: ReconcileResult;
}

export type Side = "local" | "muse";

export type ConflictPick = "local" | "muse";
