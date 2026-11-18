import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { applyStageEdit, type FileBridge } from "../shared/bridge";
import { sniffClass } from "../shared/classify";
import { projectFromPath } from "../shared/project";
import {
  DECISIONS_FILE,
  DECISIONS_TEMPLATE,
  MEMORY_FILE,
  MEMORY_TEMPLATE,
} from "../shared/knowledge";
import { GENERIC_PROFILE, GOAL_FILE, PROFILE_DIR, SOUL_FILE } from "../shared/profile";
import { bindableChatUrl } from "../shared/chatSession";
import { excerptOf } from "../shared/contextPack";
import { aggregateState, computeFileStates } from "../shared/reconcile";
import { runScan, type ScanSource } from "../shared/scan";
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
} from "../shared/types";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface StagedMeta {
  hash: string;
  size: number;
}

interface ProjectRecord {
  project: Project;
  manifest: Map<string, ManifestEntry>;
  stagedMeta: Map<string, StagedMeta>;
}

// The real FileBridge, backed by node:fs. Electron specifics are injected:
// the storage directory (the app's userData) and a folder picker function,
// so this class runs under plain Node in tests. The staging directory per
// project plays the role of the Muse-side copy: nothing is written to the
// user's folder until saveBack, and saveBack refuses unresolved conflicts.
export class NodeFileBridge implements FileBridge {
  private records = new Map<string, ProjectRecord>();
  private loaded = false;
  private genericProfile: AgentProfile = { ...GENERIC_PROFILE };

  constructor(
    private storageDir: string,
    private pickFolderPath: () => Promise<string | null>,
  ) {}

  private projectDir(id: string): string {
    return join(this.storageDir, "projects", id);
  }

  private stagedDir(id: string): string {
    return join(this.projectDir(id), "staged");
  }

  // Rejects paths that would escape the base directory. Paths crossing the
  // bridge come from scans of the user's own folder, but the guard is cheap.
  private safeJoin(base: string, relPath: string): string {
    const full = resolve(base, relPath);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`Path escapes its directory: ${relPath}`);
    }
    return full;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const settingsRaw = await fs.readFile(join(this.storageDir, "settings.json"), "utf8");
      const settings = JSON.parse(settingsRaw) as { genericProfile?: AgentProfile };
      if (settings.genericProfile) this.genericProfile = settings.genericProfile;
    } catch {
      // No settings yet: the generic profile stays at its default.
    }
    try {
      const raw = await fs.readFile(join(this.storageDir, "projects.json"), "utf8");
      const projects = JSON.parse(raw) as Project[];
      for (const project of projects) {
        const dir = this.projectDir(project.id);
        const manifestRaw = await fs.readFile(join(dir, "manifest.json"), "utf8");
        const stagedRaw = await fs.readFile(join(dir, "staged.json"), "utf8");
        const manifest = new Map<string, ManifestEntry>(
          (JSON.parse(manifestRaw) as ManifestEntry[]).map((e) => [e.path, e]),
        );
        const stagedMeta = new Map<string, StagedMeta>(
          Object.entries(JSON.parse(stagedRaw) as Record<string, StagedMeta>),
        );
        this.records.set(project.id, { project, manifest, stagedMeta });
      }
    } catch {
      // No registry yet: a fresh install has no projects.
    }
  }

  private async persist(record: ProjectRecord): Promise<void> {
    const dir = this.projectDir(record.project.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, "manifest.json"),
      JSON.stringify([...record.manifest.values()], null, 2),
    );
    await fs.writeFile(
      join(dir, "staged.json"),
      JSON.stringify(Object.fromEntries(record.stagedMeta), null, 2),
    );
    const projects = [...this.records.values()].map((r) => r.project);
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.writeFile(
      join(this.storageDir, "projects.json"),
      JSON.stringify(projects, null, 2),
    );
  }

  private async record(projectId: string): Promise<ProjectRecord> {
    await this.ensureLoaded();
    const record = this.records.get(projectId);
    if (!record) throw new Error(`Unknown project: ${projectId}`);
    return record;
  }

  // All files under a directory, as project-relative paths with sizes.
  private async collectFiles(
    rootPath: string,
    relDir: string,
  ): Promise<{ relPath: string; size: number }[]> {
    const out: { relPath: string; size: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(this.safeJoin(rootPath, dir), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(rel);
        } else if (entry.isFile()) {
          const stat = await fs.stat(this.safeJoin(rootPath, rel));
          out.push({ relPath: rel, size: stat.size });
        }
      }
    };
    await walk(relDir);
    return out;
  }

  private scanSource(rootPath: string): ScanSource {
    return {
      listTop: async () => {
        const entries = await fs.readdir(rootPath, { withFileTypes: true });
        const out: { name: string; isDir: boolean; size: number }[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            out.push({ name: entry.name, isDir: true, size: 0 });
          } else if (entry.isFile()) {
            const stat = await fs.stat(join(rootPath, entry.name));
            out.push({ name: entry.name, isDir: false, size: stat.size });
          }
        }
        return out;
      },
      readHead: async (relPath) => {
        const handle = await fs.open(this.safeJoin(rootPath, relPath), "r");
        try {
          const buffer = Buffer.alloc(8192);
          const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
          return new Uint8Array(buffer.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
      },
      readText: async (relPath) => {
        try {
          return await fs.readFile(this.safeJoin(rootPath, relPath), "utf8");
        } catch {
          return null;
        }
      },
      dirStats: async (relDir) => {
        const files = await this.collectFiles(rootPath, relDir);
        return {
          fileCount: files.length,
          size: files.reduce((sum, f) => sum + f.size, 0),
        };
      },
    };
  }

  async pickFolder(): Promise<Project | null> {
    const path = await this.pickFolderPath();
    return path ? projectFromPath(path) : null;
  }

  async scanProject(project: Project): Promise<ScanResult> {
    return runScan(this.scanSource(project.rootPath), project);
  }

  async copyIn(project: Project, selectedPaths: string[]): Promise<ReconcileResult> {
    await this.ensureLoaded();
    // Only the ticked paths: an unticked file is never copied, even if
    // the scan classified it as copyable.
    const include = new Set<string>();
    for (const extra of selectedPaths) {
      const full = this.safeJoin(project.rootPath, extra);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isFile()) {
        include.add(extra);
      } else if (stat.isDirectory()) {
        const files = await this.collectFiles(project.rootPath, extra);
        for (const file of files) include.add(file.relPath);
      }
    }

    const record: ProjectRecord = {
      project,
      manifest: new Map(),
      stagedMeta: new Map(),
    };
    this.records.set(project.id, record);
    const stagedDir = this.stagedDir(project.id);
    await fs.rm(stagedDir, { recursive: true, force: true });
    for (const relPath of include) {
      const localFull = this.safeJoin(project.rootPath, relPath);
      const bytes = await fs.readFile(localFull);
      const stat = await fs.stat(localFull);
      const hash = sha256(bytes);
      const stagedFull = this.safeJoin(stagedDir, relPath);
      await fs.mkdir(dirname(stagedFull), { recursive: true });
      await fs.writeFile(stagedFull, bytes);
      record.manifest.set(relPath, {
        path: relPath,
        hash,
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
      });
      record.stagedMeta.set(relPath, { hash, size: stat.size });
    }
    await this.persist(record);
    await this.ensureKnowledgeFiles(project.rootPath);
    return this.reconcile(project.id);
  }

  // Creates .parnassus/decisions.md and memory.md with starter headings
  // when a project is copied in. Existing files are never overwritten.
  private async ensureKnowledgeFiles(rootPath: string): Promise<void> {
    const dir = join(rootPath, PROFILE_DIR);
    await fs.mkdir(dir, { recursive: true });
    for (const [name, template] of [
      [DECISIONS_FILE, DECISIONS_TEMPLATE],
      [MEMORY_FILE, MEMORY_TEMPLATE],
    ] as const) {
      try {
        await fs.writeFile(join(dir, name), template, { encoding: "utf8", flag: "wx" });
      } catch {
        // Already there: the user's knowledge stays untouched.
      }
    }
  }

  private async readKnowledgeFile(rootPath: string, name: string): Promise<string | null> {
    try {
      return await fs.readFile(join(rootPath, PROFILE_DIR, name), "utf8");
    } catch {
      return null;
    }
  }

  async getProjectKnowledge(projectId: string): Promise<ProjectKnowledge> {
    const record = await this.record(projectId);
    const [decisions, memory] = await Promise.all([
      this.readKnowledgeFile(record.project.rootPath, DECISIONS_FILE),
      this.readKnowledgeFile(record.project.rootPath, MEMORY_FILE),
    ]);
    return { decisions, memory };
  }

  async setProjectKnowledge(
    projectId: string,
    knowledge: ProjectKnowledge,
  ): Promise<ProjectKnowledge> {
    const record = await this.record(projectId);
    const dir = join(record.project.rootPath, PROFILE_DIR);
    const write = async (name: string, value: string | null): Promise<void> => {
      if (value === null) {
        await fs.rm(join(dir, name), { force: true });
      } else {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, name), value, "utf8");
      }
    };
    await write(DECISIONS_FILE, knowledge.decisions);
    await write(MEMORY_FILE, knowledge.memory);
    return this.getProjectKnowledge(projectId);
  }

  // A project's goal/soul are read from its .parnassus files on every
  // listing, so editing goal.md or soul.md in a text editor shows up too.
  private async withProfileFiles(project: Project): Promise<Project> {
    const read = async (name: string): Promise<string | null> => {
      try {
        const raw = await fs.readFile(join(project.rootPath, PROFILE_DIR, name), "utf8");
        const trimmed = raw.trim();
        return trimmed === "" ? null : trimmed;
      } catch {
        return null;
      }
    };
    const [goal, soul] = await Promise.all([read(GOAL_FILE), read(SOUL_FILE)]);
    return { ...project, goal, soul };
  }

  // Fills in the derived per-project fields the persisted record does
  // not reliably carry: the staging folder for this project's copies.
  private withStagedPath(project: Project): Project {
    return { ...project, stagedPath: this.stagedDir(project.id) };
  }

  async setProjectChatUrl(projectId: string, chatUrl: string | null): Promise<Project> {
    const record = await this.record(projectId);
    // Only a conversation-specific muse.ai URL may be bound; the shared
    // home/main chat and auth pages would re-merge the project's chat
    // into everyone else's, so they clear the binding instead.
    record.project = { ...record.project, isolatedChatUrl: bindableChatUrl(chatUrl) };
    await this.persist(record);
    return this.withStagedPath(await this.withProfileFiles(record.project));
  }

  async listProjects(): Promise<Project[]> {
    await this.ensureLoaded();
    const projects: Project[] = [];
    for (const record of this.records.values()) {
      record.project = await this.withProfileFiles(record.project);
      projects.push(this.withStagedPath(record.project));
    }
    return projects;
  }

  async getGenericProfile(): Promise<AgentProfile> {
    await this.ensureLoaded();
    return { ...this.genericProfile };
  }

  async setGenericProfile(profile: AgentProfile): Promise<AgentProfile> {
    await this.ensureLoaded();
    this.genericProfile = { goal: profile.goal, soul: profile.soul };
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.writeFile(
      join(this.storageDir, "settings.json"),
      JSON.stringify({ genericProfile: this.genericProfile }, null, 2),
    );
    return this.getGenericProfile();
  }

  async setProjectProfile(
    projectId: string,
    profile: { goal: string | null; soul: string | null },
  ): Promise<Project> {
    const record = await this.record(projectId);
    // The .parnassus files in the user's folder are the storage: write
    // the text, or delete the file to go back to the generic value.
    const dir = join(record.project.rootPath, PROFILE_DIR);
    const write = async (name: string, value: string | null): Promise<void> => {
      const file = join(dir, name);
      if (value === null || value.trim() === "") {
        await fs.rm(file, { force: true });
      } else {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, value.endsWith("\n") ? value : `${value}\n`, "utf8");
      }
    };
    await write(GOAL_FILE, profile.goal);
    await write(SOUL_FILE, profile.soul);
    record.project = await this.withProfileFiles({
      ...record.project,
      goal: profile.goal,
      soul: profile.soul,
    });
    await this.persist(record);
    return this.withStagedPath(record.project);
  }

  async reconcile(projectId: string): Promise<ReconcileResult> {
    const record = await this.record(projectId);
    const paths = new Set([...record.manifest.keys(), ...record.stagedMeta.keys()]);
    const local = new Map<string, { hash: string }>();
    const muse = new Map<string, { hash: string }>();
    for (const path of paths) {
      const stagedMeta = record.stagedMeta.get(path);
      if (stagedMeta) muse.set(path, { hash: stagedMeta.hash });
      const localFull = this.safeJoin(record.project.rootPath, path);
      const stat = await fs.stat(localFull).catch(() => null);
      if (!stat) continue;
      const base = record.manifest.get(path);
      // Stat pass first: an untouched file keeps its manifest hash without a
      // read. Only suspects (size or mtime moved) are hashed.
      if (base && stat.size === base.size && Math.round(stat.mtimeMs) === base.mtime) {
        local.set(path, { hash: base.hash });
      } else {
        const bytes = await fs.readFile(localFull);
        local.set(path, { hash: sha256(bytes) });
      }
    }
    const files = computeFileStates(record.manifest, local, muse);
    return { projectId, state: aggregateState(files), files };
  }

  async readFile(projectId: string, path: string, side: Side): Promise<string | null> {
    const record = await this.record(projectId);
    const base = side === "local" ? record.project.rootPath : this.stagedDir(projectId);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.safeJoin(base, path));
    } catch {
      return null;
    }
    if (sniffClass(new Uint8Array(bytes.subarray(0, 8192))) !== "text") return null;
    return bytes.toString("utf8");
  }

  async stageEdit(projectId: string, path: string): Promise<ReconcileResult> {
    const record = await this.record(projectId);
    const stagedFull = this.safeJoin(this.stagedDir(projectId), path);
    const raw = await fs.readFile(stagedFull);
    if (sniffClass(new Uint8Array(raw.subarray(0, 8192))) !== "text") {
      throw new Error(`Only text files can be edited in this demo: ${path}`);
    }
    const current = raw.toString("utf8");
    const next = applyStageEdit(current);
    await fs.writeFile(stagedFull, next, "utf8");
    const bytes = Buffer.from(next, "utf8");
    record.stagedMeta.set(path, { hash: sha256(bytes), size: bytes.length });
    await this.persist(record);
    return this.reconcile(projectId);
  }

  async describeFiles(projectId: string): Promise<ContextFile[]> {
    const record = await this.record(projectId);
    const files: ContextFile[] = [];
    for (const path of [...record.stagedMeta.keys()].sort()) {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(this.safeJoin(this.stagedDir(projectId), path));
      } catch {
        continue;
      }
      const fileClass = sniffClass(new Uint8Array(bytes.subarray(0, 8192)));
      files.push({
        path,
        fileClass,
        size: record.stagedMeta.get(path)?.size ?? bytes.length,
        excerpt: fileClass === "text" ? excerptOf(bytes.toString("utf8")) : null,
      });
    }
    return files;
  }

  private async applyToLocal(record: ProjectRecord, path: string): Promise<void> {
    const stagedFull = this.safeJoin(this.stagedDir(record.project.id), path);
    const bytes = await fs.readFile(stagedFull);
    const localFull = this.safeJoin(record.project.rootPath, path);
    await fs.mkdir(dirname(localFull), { recursive: true });
    // Write to a sibling temp file, then rename over the original, so a
    // crash mid-write never leaves a truncated user file.
    const temp = `${localFull}.parnassus-tmp`;
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, localFull);
    const stat = await fs.stat(localFull);
    record.manifest.set(path, {
      path,
      hash: sha256(bytes),
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
    });
  }

  private async applyToMuse(record: ProjectRecord, path: string): Promise<void> {
    const stagedFull = this.safeJoin(this.stagedDir(record.project.id), path);
    const localFull = this.safeJoin(record.project.rootPath, path);
    const stat = await fs.stat(localFull).catch(() => null);
    if (!stat) {
      // The user deleted their file; applying that to Muse removes the
      // staged copy. (The reverse — a Muse-side deletion — never
      // deletes the user's file.)
      await fs.rm(stagedFull, { force: true });
      record.stagedMeta.delete(path);
      record.manifest.delete(path);
      return;
    }
    const bytes = await fs.readFile(localFull);
    await fs.mkdir(dirname(stagedFull), { recursive: true });
    await fs.writeFile(stagedFull, bytes);
    const hash = sha256(bytes);
    record.stagedMeta.set(path, { hash, size: stat.size });
    record.manifest.set(path, {
      path,
      hash,
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
    });
  }

  async applySync(
    projectId: string,
    directions: Record<string, SyncDirection>,
  ): Promise<SyncOutcome> {
    const record = await this.record(projectId);
    const before = await this.reconcile(projectId);
    const appliedToLocal: string[] = [];
    const appliedToMuse: string[] = [];
    const blocked: string[] = [];
    for (const file of before.files) {
      if (file.state === "in-sync") continue;
      const direction = directions[file.path];
      if (file.state === "local-changed") {
        if (direction !== "to-muse") {
          blocked.push(file.path);
          continue;
        }
        await this.applyToMuse(record, file.path);
        appliedToMuse.push(file.path);
      } else if (file.state === "muse-changed") {
        if (direction !== "to-local" || !record.stagedMeta.has(file.path)) {
          blocked.push(file.path);
          continue;
        }
        await this.applyToLocal(record, file.path);
        appliedToLocal.push(file.path);
      } else {
        // conflict
        if (direction === "to-local" && record.stagedMeta.has(file.path)) {
          await this.applyToLocal(record, file.path);
          appliedToLocal.push(file.path);
        } else if (direction === "to-muse") {
          await this.applyToMuse(record, file.path);
          appliedToMuse.push(file.path);
        } else {
          blocked.push(file.path);
        }
      }
    }
    await this.persist(record);
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
    // Files this older entry point never handled (local-changed alone,
    // unresolved conflicts) are not "blocked" in its terms unless a
    // conflict went unresolved.
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
}
