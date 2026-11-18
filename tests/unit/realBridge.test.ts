import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileBridge } from "../../src/main/realBridge";
import type { Project } from "../../src/shared/types";

let root = "";
let storage = "";
let bridge: NodeFileBridge;
let project: Project;

const notesPath = () => join(root, "notes.txt");
const readNotes = () => fs.readFile(notesPath(), "utf8");

async function touchFuture(path: string): Promise<void> {
  const when = new Date(Date.now() + 60_000);
  await fs.utimes(path, when, when);
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "parnassus-user-"));
  storage = await fs.mkdtemp(join(tmpdir(), "parnassus-storage-"));
  await fs.writeFile(join(root, "notes.txt"), "First note.\nSecond note.\n");
  await fs.writeFile(join(root, "README.md"), "# Fixture\n");
  await fs.writeFile(
    join(root, "payload.bin"),
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 1, 2, 3]),
  );
  await fs.mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(join(root, "node_modules", "left-pad", "index.js"), "x();\n");
  bridge = new NodeFileBridge(storage, async () => root);
  const picked = await bridge.pickFolder();
  if (!picked) throw new Error("pickFolder returned null");
  project = picked;
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(storage, { recursive: true, force: true });
});

describe("NodeFileBridge", () => {
  test("scan classifies and skips by the shared rules", async () => {
    const scan = await bridge.scanProject(project);
    const filePaths = scan.files.map((f) => f.path);
    expect(filePaths).toContain("notes.txt");
    expect(filePaths).toContain("README.md");
    const skips = Object.fromEntries(scan.skipped.map((s) => [s.path, s.reason]));
    expect(skips["payload.bin"]).toBe("binary");
    expect(skips["node_modules"]).toBe("junk");
  });

  test("copy-in lands in-sync and leaves the original untouched", async () => {
    const result = await bridge.copyIn(project, ["notes.txt", "README.md"]);
    expect(result.state).toBe("in-sync");
    expect(result.files.map((f) => f.path).sort()).toEqual(["README.md", "notes.txt"]);
    expect(await readNotes()).toBe("First note.\nSecond note.\n");
    const projects = await bridge.listProjects();
    expect(projects.map((p) => p.id)).toContain(project.id);
  });

  test("copy-in with nothing ticked copies no files", async () => {
    const result = await bridge.copyIn(project, []);
    expect(result.files).toEqual([]);
  });

  test("an unticked file is not copied even when others are", async () => {
    const result = await bridge.copyIn(project, ["notes.txt", "README.md"]);
    expect(result.files.map((f) => f.path)).not.toContain("payload.bin");
    expect(result.state).toBe("in-sync");
  });

  test("a staged edit saves back on approval", async () => {
    const edited = await bridge.stageEdit(project.id, "notes.txt");
    expect(edited.state).toBe("muse-changed");
    expect(await readNotes()).toBe("First note.\nSecond note.\n");
    const outcome = await bridge.saveBack(project.id, {});
    expect(outcome.written).toContain("notes.txt");
    expect(outcome.result.state).toBe("in-sync");
    expect(await readNotes()).toContain("Line added while working on the Muse side.");
  });

  test("a local edit shows as local-changed", async () => {
    await fs.writeFile(notesPath(), "Local rewrite, longer than before.\n");
    await touchFuture(notesPath());
    const result = await bridge.reconcile(project.id);
    expect(result.state).toBe("local-changed");
  });

  test("applySync sends a local change to Muse only in that direction", async () => {
    const refused = await bridge.applySync(project.id, {});
    expect(refused.blocked).toContain("notes.txt");
    expect(refused.result.state).toBe("local-changed");

    const described = await bridge.describeFiles(project.id);
    expect(described.map((f) => f.path)).toContain("notes.txt");
    expect(described.find((f) => f.path === "notes.txt")?.excerpt).toContain("First note");

    const applied = await bridge.applySync(project.id, { "notes.txt": "to-muse" });
    expect(applied.appliedToMuse).toContain("notes.txt");
    expect(applied.result.state).toBe("in-sync");
    // The staged copy now holds the local text: editing it works from there.
    const edited = await bridge.stageEdit(project.id, "notes.txt");
    expect(edited.state).toBe("muse-changed");
    const back = await bridge.applySync(project.id, { "notes.txt": "to-local" });
    expect(back.appliedToLocal).toContain("notes.txt");
    expect(back.result.state).toBe("in-sync");
  });

  test("a conflict blocks save-back until a winner is picked", async () => {
    await fs.writeFile(notesPath(), "Local rewrite, longer than before.\n");
    await touchFuture(notesPath());
    await bridge.stageEdit(project.id, "notes.txt");
    const conflicted = await bridge.reconcile(project.id);
    expect(conflicted.state).toBe("conflict");

    const refused = await bridge.saveBack(project.id, {});
    expect(refused.blocked).toContain("notes.txt");
    expect(await readNotes()).toBe("Local rewrite, longer than before.\n");

    const resolved = await bridge.saveBack(project.id, { "notes.txt": "muse" });
    expect(resolved.written).toContain("notes.txt");
    expect(resolved.result.state).toBe("in-sync");
    expect(await readNotes()).toContain("Line added while working on the Muse side.");
  });

  test("projects inherit the generic goal and soul until updated", async () => {
    const generic = await bridge.getGenericProfile();
    expect(generic.goal.length).toBeGreaterThan(0);
    expect(generic.soul.length).toBeGreaterThan(0);

    const updated = await bridge.setProjectProfile(project.id, {
      goal: "Ship the field guide",
      soul: null,
    });
    expect(updated.goal).toBe("Ship the field guide");
    expect(updated.soul).toBeNull();
    // Stored as special files inside the project folder itself.
    expect(await fs.readFile(join(root, ".parnassus", "goal.md"), "utf8")).toContain(
      "Ship the field guide",
    );
    await expect(fs.stat(join(root, ".parnassus", "soul.md"))).rejects.toThrow();
    const listed = await bridge.listProjects();
    expect(listed.find((p) => p.id === project.id)?.goal).toBe("Ship the field guide");

    // The .parnassus folder never shows up in a scan.
    const scan = await bridge.scanProject(project);
    expect(scan.files.map((f) => f.path)).not.toContain(".parnassus/goal.md");
    expect(scan.skipped.map((s) => s.path)).not.toContain(".parnassus");
    expect(scan.deepDirs.map((d) => d.path)).not.toContain(".parnassus");

    // Going back to generic deletes the files.
    const restored = await bridge.setProjectProfile(project.id, { goal: null, soul: null });
    expect(restored.goal).toBeNull();
    expect(restored.soul).toBeNull();
    await expect(fs.stat(join(root, ".parnassus", "goal.md"))).rejects.toThrow();
  });

  test("copy-in creates decisions.md and memory.md and never overwrites them", async () => {
    const decisions = await fs.readFile(join(root, ".parnassus", "decisions.md"), "utf8");
    const memory = await fs.readFile(join(root, ".parnassus", "memory.md"), "utf8");
    expect(decisions).toContain("# Decisions");
    expect(memory).toContain("# Project memory");

    await bridge.setProjectKnowledge(project.id, {
      decisions: "# Decisions\n\n- Use the retry helper in api files.\n",
      memory: "# Project memory\n\n- In notes.txt, dates are day-first.\n",
    });
    await bridge.copyIn(project, ["notes.txt", "README.md"]);
    const after = await bridge.getProjectKnowledge(project.id);
    expect(after.decisions).toContain("retry helper");
    expect(after.memory).toContain("day-first");
  });

  test("knowledge edited on disk is picked up on the next check", async () => {
    await fs.writeFile(join(root, ".parnassus", "memory.md"), "# Project memory\n\nEdited outside.\n");
    const knowledge = await bridge.getProjectKnowledge(project.id);
    expect(knowledge.memory).toContain("Edited outside");
  });

  test("the generic profile can be updated and persists", async () => {
    const saved = await bridge.setGenericProfile({ goal: "Generic goal", soul: "Generic soul" });
    expect(saved).toEqual({ goal: "Generic goal", soul: "Generic soul" });
    expect(await bridge.getGenericProfile()).toEqual({ goal: "Generic goal", soul: "Generic soul" });
  });

  test("a project's chat URL and staging folder persist and stay per-project", async () => {
    const listed = await bridge.listProjects();
    const mine = listed.find((p) => p.id === project.id);
    expect(mine?.stagedPath).toBe(join(storage, "projects", project.id, "staged"));

    // The shared main chat and the new-thread draft can never be bound.
    const home = await bridge.setProjectChatUrl(project.id, "https://muse.ai/");
    expect(home.isolatedChatUrl).toBeNull();
    const draft = await bridge.setProjectChatUrl(project.id, "https://muse.ai/thread/new");
    expect(draft.isolatedChatUrl).toBeNull();

    const bound = await bridge.setProjectChatUrl(project.id, "https://muse.ai/thread/abc-123");
    expect(bound.isolatedChatUrl).toBe("https://muse.ai/thread/abc-123");
    expect(bound.stagedPath).toBe(join(storage, "projects", project.id, "staged"));

    // Survives a fresh bridge over the same storage (app restart).
    const reopened = new NodeFileBridge(storage, async () => root);
    const relisted = await reopened.listProjects();
    expect(relisted.find((p) => p.id === project.id)?.isolatedChatUrl).toBe(
      "https://muse.ai/thread/abc-123",
    );
  });

  test("picking the local version keeps the local file and clears the state", async () => {
    await fs.writeFile(notesPath(), "Second local rewrite.\n");
    await touchFuture(notesPath());
    await bridge.stageEdit(project.id, "notes.txt");
    expect((await bridge.reconcile(project.id)).state).toBe("conflict");
    const outcome = await bridge.saveBack(project.id, { "notes.txt": "local" });
    expect(outcome.keptLocal).toContain("notes.txt");
    expect(outcome.result.state).toBe("in-sync");
    expect(await readNotes()).toBe("Second local rewrite.\n");
  });
});
