import { applyStageEdit, type FileBridge } from "@shared/bridge";
import { bindableChatUrl } from "@shared/chatSession";
import { fnvHash, sniffClass } from "@shared/classify";
import { projectFromPath } from "@shared/project";
import {
  DECISIONS_FILE,
  DECISIONS_TEMPLATE,
  MEMORY_FILE,
  MEMORY_TEMPLATE,
} from "@shared/knowledge";
import { GENERIC_PROFILE, GOAL_FILE, PROFILE_DIR, SOUL_FILE } from "@shared/profile";
import { excerptOf } from "@shared/contextPack";
import { aggregateState, computeFileStates } from "@shared/reconcile";
import { runScan, type ScanSource } from "@shared/scan";
import type {
  AgentProfile,
  ConflictPick,
  ContextFile,
  ManifestEntry,
  Project,
  ProjectKnowledge,
  ReconcileResult,
  SaveBackOutcome,
  ScanResult,
  Side,
  SyncDirection,
  SyncOutcome,
} from "@shared/types";

interface MockFile {
  bytes: Uint8Array;
  size: number;
  mtime: number;
}

interface MockRecord {
  project: Project;
  manifest: Map<string, ManifestEntry>;
  staged: Map<string, MockFile>;
}

const text = (s: string) => new TextEncoder().encode(s);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const MOCK_ROOT = "/mock/field-notes";
export const MOCK_PROJECT: Project = projectFromPath(MOCK_ROOT);

// The seeded tree the mock pretends is the user's disk. It contains one of
// everything the scan rules care about: plain text, a readable image and
// PDF, an opaque executable, an oversized text file, a gitignored log, junk
// directories, and a deep source directory that is listed but not copied.
function seedDisk(): Map<string, MockFile> {
  let tick = 1_700_000_000_000;
  const file = (content: string | Uint8Array, size?: number): MockFile => {
    const bytes = typeof content === "string" ? text(content) : content;
    tick += 1000;
    return { bytes, size: size ?? bytes.length, mtime: tick };
  };
  const bigLine = `${"0123456789".repeat(100)}\n`;
  const bigText = bigLine.repeat(6600); // about 6.6 MB of plain text
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7),
  ]);
  const elf = new Uint8Array([
    0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, ...new Array(400).fill(3),
  ]);
  return new Map<string, MockFile>([
    ["README.md", file("# Field notes\nA small notebook project.\n")],
    ["notes.txt", file("First note.\nSecond note.\n")],
    [".gitignore", file("*.log\n")],
    ["photo.png", file(png)],
    ["report.pdf", file("%PDF-1.7\nmock pdf body\n")],
    ["payload.bin", file(elf)],
    ["huge-dump.txt", file(bigText)],
    ["debug.log", file("2026-11-13 debug output\n")],
    ["node_modules/left-pad/index.js", file("module.exports = () => '';\n")],
    ["node_modules/left-pad/package.json", file('{"name":"left-pad"}\n')],
    [".git/config", file("[core]\n\trepositoryformatversion = 0\n")],
    ["dist/bundle.js", file("console.log('bundled');\n")],
    ["src/main.ts", file("export const main = () => 1;\n")],
    ["src/util.ts", file("export const util = () => 2;\n")],
  ]);
}

// An in-memory FileBridge. Used when the renderer runs in a plain browser
// (vite dev server, Playwright) where there is no Electron main process.
// It follows the same rules as the real bridge because the scan and the
// state computation are the shared implementations; only the storage is
// fake. Nothing here touches the real filesystem.
export class MockBridge implements FileBridge {
  private disk = seedDisk();
  private records = new Map<string, MockRecord>();
  private clock = 1_700_100_000_000;
  private genericProfile: AgentProfile = { ...GENERIC_PROFILE };

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private scanSource: ScanSource = {
    listTop: async () => {
      const seen = new Map<string, { name: string; isDir: boolean; size: number }>();
      for (const [path, entry] of this.disk) {
        const slash = path.indexOf("/");
        if (slash === -1) {
          seen.set(path, { name: path, isDir: false, size: entry.size });
        } else {
          const name = path.slice(0, slash);
          if (!seen.has(name)) seen.set(name, { name, isDir: true, size: 0 });
        }
      }
      return [...seen.values()];
    },
    readHead: async (relPath) => {
      const entry = this.disk.get(relPath);
      return entry ? entry.bytes.subarray(0, 8192) : new Uint8Array(0);
    },
    readText: async (relPath) => {
      const entry = this.disk.get(relPath);
      return entry ? decode(entry.bytes) : null;
    },
    dirStats: async (relDir) => {
      let fileCount = 0;
      let size = 0;
      for (const [path, entry] of this.disk) {
        if (path.startsWith(`${relDir}/`)) {
          fileCount++;
          size += entry.size;
        }
      }
      return { fileCount, size };
    },
  };

  async pickFolder(): Promise<Project | null> {
    return MOCK_PROJECT;
  }

  async scanProject(project: Project): Promise<ScanResult> {
    return runScan(this.scanSource, project);
  }

  private includedPaths(selected: string[]): Set<string> {
    const include = new Set<string>();
    for (const extra of selected) {
      if (this.disk.has(extra)) {
        include.add(extra);
        continue;
      }
      // A directory extra includes everything under it.
      for (const path of this.disk.keys()) {
        if (path.startsWith(`${extra}/`)) include.add(path);
      }
    }
    return include;
  }

  async copyIn(project: Project, selectedPaths: string[]): Promise<ReconcileResult> {
    const include = this.includedPaths(selectedPaths);
    const manifest = new Map<string, ManifestEntry>();
    const staged = new Map<string, MockFile>();
    for (const path of include) {
      const entry = this.disk.get(path);
      if (!entry) continue;
      manifest.set(path, {
        path,
        hash: fnvHash(entry.bytes),
        size: entry.size,
        mtime: entry.mtime,
      });
      staged.set(path, {
        bytes: entry.bytes.slice(),
        size: entry.size,
        mtime: entry.mtime,
      });
    }
    this.records.set(project.id, { project, manifest, staged });
    this.ensureKnowledgeFiles();
    return this.reconcile(project.id);
  }

  private ensureKnowledgeFiles(): void {
    for (const [name, template] of [
      [DECISIONS_FILE, DECISIONS_TEMPLATE],
      [MEMORY_FILE, MEMORY_TEMPLATE],
    ] as const) {
      const key = `${PROFILE_DIR}/${name}`;
      if (!this.disk.has(key)) {
        const bytes = text(template);
        this.disk.set(key, { bytes, size: bytes.length, mtime: this.tick() });
      }
    }
  }

  async getProjectKnowledge(projectId: string): Promise<ProjectKnowledge> {
    this.record(projectId);
    const read = (name: string): string | null => {
      const entry = this.disk.get(`${PROFILE_DIR}/${name}`);
      return entry ? decode(entry.bytes) : null;
    };
    return { decisions: read(DECISIONS_FILE), memory: read(MEMORY_FILE) };
  }

  async setProjectKnowledge(
    projectId: string,
    knowledge: ProjectKnowledge,
  ): Promise<ProjectKnowledge> {
    this.record(projectId);
    const write = (name: string, value: string | null): void => {
      const key = `${PROFILE_DIR}/${name}`;
      if (value === null) {
        this.disk.delete(key);
      } else {
        const bytes = text(value);
        this.disk.set(key, { bytes, size: bytes.length, mtime: this.tick() });
      }
    };
    write(DECISIONS_FILE, knowledge.decisions);
    write(MEMORY_FILE, knowledge.memory);
    return this.getProjectKnowledge(projectId);
  }

  private withProfileFiles(project: Project): Project {
    const read = (name: string): string | null => {
      const entry = this.disk.get(`${PROFILE_DIR}/${name}`);
      if (!entry) return null;
      const trimmed = decode(entry.bytes).trim();
      return trimmed === "" ? null : trimmed;
    };
    return { ...project, goal: read(GOAL_FILE), soul: read(SOUL_FILE) };
  }

  private withStagedPath(project: Project): Project {
    return { ...project, stagedPath: `/mock/parnassus/projects/${project.id}/staged` };
  }

  async setProjectChatUrl(projectId: string, chatUrl: string | null): Promise<Project> {
    const record = this.record(projectId);
    record.project = { ...record.project, isolatedChatUrl: bindableChatUrl(chatUrl) };
    return this.withStagedPath(record.project);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.records.values()].map((r) => {
      r.project = this.withProfileFiles(r.project);
      return this.withStagedPath(r.project);
    });
  }

  async getGenericProfile(): Promise<AgentProfile> {
    return { ...this.genericProfile };
  }

  async setGenericProfile(profile: AgentProfile): Promise<AgentProfile> {
    this.genericProfile = { goal: profile.goal, soul: profile.soul };
    return this.getGenericProfile();
  }

  async setProjectProfile(
    projectId: string,
    profile: { goal: string | null; soul: string | null },
  ): Promise<Project> {
    const record = this.record(projectId);
    const write = (name: string, value: string | null): void => {
      const key = `${PROFILE_DIR}/${name}`;
      if (value === null || value.trim() === "") {
        this.disk.delete(key);
      } else {
        const bytes = text(value.endsWith("\n") ? value : `${value}\n`);
        this.disk.set(key, { bytes, size: bytes.length, mtime: this.tick() });
      }
    };
    write(GOAL_FILE, profile.goal);
    write(SOUL_FILE, profile.soul);
    record.project = this.withProfileFiles(record.project);
    return this.withStagedPath(record.project);
  }

  private record(projectId: string): MockRecord {
    const record = this.records.get(projectId);
    if (!record) throw new Error(`Unknown project: ${projectId}`);
    return record;
  }

  async reconcile(projectId: string): Promise<ReconcileResult> {
    const record = this.record(projectId);
    const paths = new Set([...record.manifest.keys(), ...record.staged.keys()]);
    const local = new Map<string, { hash: string }>();
    const muse = new Map<string, { hash: string }>();
    for (const path of paths) {
      const localFile = this.disk.get(path);
      if (localFile) local.set(path, { hash: fnvHash(localFile.bytes) });
      const stagedFile = record.staged.get(path);
      if (stagedFile) muse.set(path, { hash: fnvHash(stagedFile.bytes) });
    }
    const files = computeFileStates(record.manifest, local, muse);
    return { projectId, state: aggregateState(files), files };
  }

  async readFile(projectId: string, path: string, side: Side): Promise<string | null> {
    const record = this.record(projectId);
    const entry = side === "local" ? this.disk.get(path) : record.staged.get(path);
    if (!entry) return null;
    if (sniffClass(entry.bytes.subarray(0, 8192)) !== "text") return null;
    return decode(entry.bytes);
  }

  async stageEdit(projectId: string, path: string): Promise<ReconcileResult> {
    const record = this.record(projectId);
    const stagedFile = record.staged.get(path);
    if (!stagedFile) throw new Error(`File is not staged: ${path}`);
    if (sniffClass(stagedFile.bytes.subarray(0, 8192)) !== "text") {
      throw new Error(`Only text files can be edited in this demo: ${path}`);
    }
    const next = text(applyStageEdit(decode(stagedFile.bytes)));
    record.staged.set(path, { bytes: next, size: next.length, mtime: this.tick() });
    return this.reconcile(projectId);
  }

  async describeFiles(projectId: string): Promise<ContextFile[]> {
    const record = this.record(projectId);
    return [...record.staged.keys()].sort().map((path) => {
      const entry = record.staged.get(path)!;
      const fileClass = sniffClass(entry.bytes.subarray(0, 8192));
      return {
        path,
        fileClass,
        size: entry.size,
        excerpt: fileClass === "text" ? excerptOf(decode(entry.bytes)) : null,
      };
    });
  }

  async applySync(
    projectId: string,
    directions: Record<string, SyncDirection>,
  ): Promise<SyncOutcome> {
    const record = this.record(projectId);
    const before = await this.reconcile(projectId);
    const appliedToLocal: string[] = [];
    const appliedToMuse: string[] = [];
    const blocked: string[] = [];
    const applyToMuse = (path: string): void => {
      const localFile = this.disk.get(path);
      if (!localFile) {
        record.staged.delete(path);
        record.manifest.delete(path);
        return;
      }
      record.staged.set(path, {
        bytes: localFile.bytes.slice(),
        size: localFile.size,
        mtime: localFile.mtime,
      });
      record.manifest.set(path, {
        path,
        hash: fnvHash(localFile.bytes),
        size: localFile.size,
        mtime: localFile.mtime,
      });
    };
    for (const file of before.files) {
      if (file.state === "in-sync") continue;
      const direction = directions[file.path];
      const stagedFile = record.staged.get(file.path);
      if (file.state === "local-changed") {
        if (direction !== "to-muse") {
          blocked.push(file.path);
          continue;
        }
        applyToMuse(file.path);
        appliedToMuse.push(file.path);
      } else if (file.state === "muse-changed") {
        if (direction !== "to-local" || !stagedFile) {
          blocked.push(file.path);
          continue;
        }
        this.writeLocal(record, file.path, stagedFile);
        appliedToLocal.push(file.path);
      } else if (direction === "to-local" && stagedFile) {
        this.writeLocal(record, file.path, stagedFile);
        appliedToLocal.push(file.path);
      } else if (direction === "to-muse") {
        applyToMuse(file.path);
        appliedToMuse.push(file.path);
      } else {
        blocked.push(file.path);
      }
    }
    const result = await this.reconcile(projectId);
    return { appliedToLocal, appliedToMuse, blocked, result };
  }

  async saveBack(
    projectId: string,
    resolutions: Record<string, ConflictPick>,
  ): Promise<SaveBackOutcome> {
    const before = await this.reconcile(projectId);
    const directions: Record<string, SyncDirection> = {};
    for (const file of before.files) {
      if (file.state === "muse-changed") directions[file.path] = "to-local";
      else if (file.state === "conflict" && resolutions[file.path] === "muse") {
        directions[file.path] = "to-local";
      } else if (file.state === "conflict" && resolutions[file.path] === "local") {
        directions[file.path] = "to-muse";
      }
    }
    const outcome = await this.applySync(projectId, directions);
    const blocked = outcome.blocked.filter((path) => {
      const file = before.files.find((f) => f.path === path);
      return file?.state === "conflict" || file?.state === "muse-changed";
    });
    return {
      written: outcome.appliedToLocal,
      keptLocal: outcome.appliedToMuse,
      blocked,
      result: outcome.result,
    };
  }

  private writeLocal(record: MockRecord, path: string, stagedFile: MockFile): void {
    const mtime = this.tick();
    this.disk.set(path, { bytes: stagedFile.bytes.slice(), size: stagedFile.size, mtime });
    record.manifest.set(path, {
      path,
      hash: fnvHash(stagedFile.bytes),
      size: stagedFile.size,
      mtime,
    });
  }

  // Test and demo hook: simulates the user editing a file in their own
  // folder, outside the app. Playwright uses this to set up local changes
  // and conflicts.
  editLocal(path: string, content: string): void {
    const bytes = text(content);
    this.disk.set(path, { bytes, size: bytes.length, mtime: this.tick() });
  }
}
