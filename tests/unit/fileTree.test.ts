import { describe, expect, test } from "bun:test";
import { buildFileTree, countByState } from "../../src/shared/fileTree";
import type { FileState } from "../../src/shared/types";

const files: FileState[] = [
  { path: "notes.txt", state: "in-sync" },
  { path: "src/main.ts", state: "local-changed" },
  { path: "src/util.ts", state: "in-sync" },
  { path: "src/deep/api.ts", state: "conflict" },
  { path: "README.md", state: "muse-changed" },
];

describe("buildFileTree", () => {
  test("nests files under their folders, folders first", () => {
    const tree = buildFileTree(files);
    expect(tree.map((n) => n.name)).toEqual(["src", "notes.txt", "README.md"]);
    const src = tree[0]!;
    expect(src.isFolder).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["deep", "main.ts", "util.ts"]);
    expect(src.children[0]!.children.map((n) => n.path)).toEqual(["src/deep/api.ts"]);
  });

  test("a folder carries the aggregate state of what is under it", () => {
    const tree = buildFileTree(files);
    // A conflict anywhere under src makes the folder show conflict.
    expect(tree[0]!.state).toBe("conflict");
    expect(tree[0]!.children[0]!.state).toBe("conflict");
    const synced = buildFileTree([{ path: "a/b.txt", state: "in-sync" }]);
    expect(synced[0]!.state).toBe("in-sync");
  });

  test("counts files per sync state for the summary line", () => {
    expect(countByState(files)).toEqual({
      "in-sync": 2,
      "local-changed": 1,
      "muse-changed": 1,
      conflict: 1,
    });
    expect(countByState([])).toEqual({
      "in-sync": 0,
      "local-changed": 0,
      "muse-changed": 0,
      conflict: 0,
    });
  });
});
