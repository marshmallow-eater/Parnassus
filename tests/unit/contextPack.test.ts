import { describe, expect, test } from "bun:test";
import {
  buildContextPack,
  contextSignature,
  pickRelevantFiles,
} from "../../src/shared/contextPack";
import type { ContextFile } from "../../src/shared/types";

const files: ContextFile[] = [
  { path: "notes.txt", fileClass: "text", size: 25, excerpt: "First note. Second note." },
  { path: "photo.png", fileClass: "readable-binary", size: 2048, excerpt: null },
  { path: "payload.bin", fileClass: "opaque-binary", size: 512, excerpt: null },
];

describe("buildContextPack", () => {
  test("lists each file with a short description of what is inside", () => {
    const pack = buildContextPack({
      projectName: "field-notes",
      goal: "Ship the field guide",
      soul: "Careful",
      files,
    });
    expect(pack).toContain("field-notes");
    expect(pack).toContain("Ship the field guide");
    expect(pack).toContain("notes.txt");
    expect(pack).toContain("First note. Second note.");
    expect(pack).toContain("photo.png");
    expect(pack).toContain("readable binary");
    expect(pack).not.toContain("payload.bin content");
  });

  test("points the agent at this project's folders and no other project's", () => {
    const pack = buildContextPack({
      projectName: "field-notes",
      goal: "Ship the field guide",
      soul: "Careful",
      files,
      rootPath: "/home/user/field-notes",
      stagedPath: "/data/parnassus/projects/p-aaa/staged",
      workFolder: "parnassus/projects/field-notes-p-aaa",
    });
    expect(pack).toContain("only for the project \"field-notes\"");
    expect(pack).toContain("Name this chat \"field-notes\"");
    expect(pack).toContain("/home/user/field-notes");
    expect(pack).toContain("/home/user/field-notes/.parnassus");
    expect(pack).toContain("/data/parnassus/projects/p-aaa/staged");
    expect(pack).toContain("~/parnassus/projects/field-notes-p-aaa/");
    // Summaries first; full content only when the agent requests a
    // file with the loop marker.
    expect(pack).toContain("summaries only");
    expect(pack).toContain("PARNASSUS_FILE_REQUEST: <path>");
  });

  test("works with no files and no goal", () => {
    const pack = buildContextPack({ projectName: "empty", goal: "", soul: "", files: [] });
    expect(pack).toContain("empty");
    expect(pack).toContain("No files");
  });

  test("a question naming a file picks that file for full inclusion", () => {
    expect(pickRelevantFiles("what does notes.txt say about the second note?", files)).toEqual([
      "notes.txt",
    ]);
  });

  test("a question matching a file's description picks it too", () => {
    const withDesc: ContextFile[] = [
      { path: "api.ts", fileClass: "text", size: 90, excerpt: "retry helper with backoff for fetch calls" },
      { path: "notes.txt", fileClass: "text", size: 25, excerpt: "First note. Second note." },
    ];
    expect(pickRelevantFiles("where is the retry backoff handled?", withDesc)).toEqual(["api.ts"]);
  });

  test("an unrelated question picks nothing, and picks are capped", () => {
    expect(pickRelevantFiles("what is the weather?", files)).toEqual([]);
    const many: ContextFile[] = Array.from({ length: 6 }, (_, i) => ({
      path: `file-${i}.txt`,
      fileClass: "text" as const,
      size: 10,
      excerpt: "common shared words here",
    }));
    expect(pickRelevantFiles("common shared words", many).length).toBeLessThanOrEqual(3);
  });

  test("the signature changes when a file description changes", () => {
    const a = buildContextPack({ projectName: "p", goal: "", soul: "", files });
    const changed: ContextFile[] = [
      { ...files[0]!, excerpt: "Edited note." },
      files[1]!,
      files[2]!,
    ];
    const b = buildContextPack({ projectName: "p", goal: "", soul: "", files: changed });
    expect(contextSignature(a)).not.toBe(contextSignature(b));
    expect(contextSignature(a)).toBe(contextSignature(a));
  });
});
