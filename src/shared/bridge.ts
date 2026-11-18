import type {
  AgentProfile,
  ConflictPick,
  ContextFile,
  Project,
  ProjectKnowledge,
  ReconcileResult,
  SaveBackOutcome,
  ScanResult,
  Side,
  SyncDirection,
  SyncOutcome,
} from "./types";

// The line stageEdit appends to a staged text file. It stands in for a real
// agent edit so the review and save-back flow can be exercised end to end.
export const STAGE_EDIT_LINE = "Line added while working on the Muse side.";

export function applyStageEdit(content: string): string {
  const prefix = content === "" || content.endsWith("\n") ? content : `${content}\n`;
  return `${prefix}${STAGE_EDIT_LINE}\n`;
}

// Every filesystem operation the UI needs goes through this interface. The
// renderer only ever sees this contract: in Electron it is backed by the
// real implementation in the main process, in a plain browser by the
// in-memory mock. The renderer never touches fs directly.
export interface FileBridge {
  // Opens the folder picker (Electron) or returns the seeded mock folder.
  // Null means the user cancelled.
  pickFolder(): Promise<Project | null>;
  // Shallow scan of a project folder: classification, skip list, deep dirs.
  scanProject(project: Project): Promise<ScanResult>;
  // Copies exactly the paths the user ticked in the scan dialog (files,
  // or deep directories meaning everything under them) into the staging
  // area, writes the manifest, returns the fresh sync state. Unticked
  // files are never copied: adding a folder grants nothing by itself.
  copyIn(project: Project, selectedPaths: string[]): Promise<ReconcileResult>;
  listProjects(): Promise<Project[]>;
  // Three-way check of local files against the manifest and the staged
  // copies. Runs every time a project is opened.
  reconcile(projectId: string): Promise<ReconcileResult>;
  // Text content of a file on one side, for diffs. Null for binary files and
  // for files that do not exist on that side.
  readFile(projectId: string, path: string, side: Side): Promise<string | null>;
  // Simulates a Muse-side change: appends a marker line to the staged copy.
  // Stands in for real agent edits until Muse integration lands.
  stageEdit(projectId: string, path: string): Promise<ReconcileResult>;
  // Writes staged changes back to the user's folder. Files in conflict are
  // only written when resolutions names a winner for them; unresolved
  // conflicts are reported in blocked and never overwritten.
  saveBack(
    projectId: string,
    resolutions: Record<string, ConflictPick>,
  ): Promise<SaveBackOutcome>;
  // The generic goal and agent soul every project inherits by default.
  getGenericProfile(): Promise<AgentProfile>;
  setGenericProfile(profile: AgentProfile): Promise<AgentProfile>;
  // Sets a project's own goal/soul. A null field goes back to inheriting
  // the generic value for that field. Returns the updated project.
  setProjectProfile(
    projectId: string,
    profile: { goal: string | null; soul: string | null },
  ): Promise<Project>;
  // Reads .parnassus/decisions.md and memory.md fresh from the project
  // folder, so edits made in a text editor are picked up on every check.
  getProjectKnowledge(projectId: string): Promise<ProjectKnowledge>;
  setProjectKnowledge(projectId: string, knowledge: ProjectKnowledge): Promise<ProjectKnowledge>;
  // Binds the muse.ai conversation URL that belongs to this project's
  // isolated chat (or clears it with null / a non-conversation URL), so
  // reopening the project reopens that conversation, never another
  // project's or the shared main chat. Returns the updated project.
  setProjectChatUrl(projectId: string, chatUrl: string | null): Promise<Project>;
  // The Muse-side (staged) files described for a chat's context pack.
  describeFiles(projectId: string): Promise<ContextFile[]>;
  // The one sync review: for every differing file the user picked a
  // direction, and only those files move. Files in conflict (or changed
  // on the side opposite their direction) without a usable direction are
  // reported blocked and never touched. A Muse-side deletion is never
  // applied to the user's folder.
  applySync(
    projectId: string,
    directions: Record<string, SyncDirection>,
  ): Promise<SyncOutcome>;
}
