import { describe, expect, test } from "bun:test";
import { aggregateState, computeFileStates } from "../../src/shared/reconcile";
import type { ManifestEntry, SyncState } from "../../src/shared/types";

const base = (entries: Record<string, string>) =>
  new Map<string, ManifestEntry>(
    Object.entries(entries).map(([path, hash]) => [
      path,
      { path, hash, size: 10, mtime: 1000 },
    ]),
  );
const side = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, hash]) => [path, { hash }]));

const stateOf = (
  b: Record<string, string>,
  l: Record<string, string>,
  m: Record<string, string>,
  path: string,
) => computeFileStates(base(b), side(l), side(m)).find((f) => f.path === path)?.state;

describe("computeFileStates", () => {
  test("identical on all three sides is in-sync", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h1" }, { "a.txt": "h1" }, "a.txt")).toBe(
      "in-sync",
    );
  });

  test("only the local side moved: local-changed", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h2" }, { "a.txt": "h1" }, "a.txt")).toBe(
      "local-changed",
    );
  });

  test("only the Muse side moved: muse-changed", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h1" }, { "a.txt": "h2" }, "a.txt")).toBe(
      "muse-changed",
    );
  });

  test("both sides moved to different content: conflict", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h2" }, { "a.txt": "h3" }, "a.txt")).toBe(
      "conflict",
    );
  });

  test("both sides moved to the same content: in-sync", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h2" }, { "a.txt": "h2" }, "a.txt")).toBe(
      "in-sync",
    );
  });

  test("deleted locally counts as a local change", () => {
    expect(stateOf({ "a.txt": "h1" }, {}, { "a.txt": "h1" }, "a.txt")).toBe("local-changed");
  });

  test("deleted on the Muse side counts as a Muse change", () => {
    expect(stateOf({ "a.txt": "h1" }, { "a.txt": "h1" }, {}, "a.txt")).toBe("muse-changed");
  });

  test("deleted on both sides is in-sync", () => {
    expect(stateOf({ "a.txt": "h1" }, {}, {}, "a.txt")).toBe("in-sync");
  });

  test("a file that only exists locally is a local change", () => {
    expect(stateOf({}, { "new.txt": "h1" }, {}, "new.txt")).toBe("local-changed");
  });

  test("a file that only exists on the Muse side is a Muse change", () => {
    expect(stateOf({}, {}, { "new.txt": "h1" }, "new.txt")).toBe("muse-changed");
  });

  test("a file created identically on both sides is in-sync", () => {
    expect(stateOf({}, { "new.txt": "h1" }, { "new.txt": "h1" }, "new.txt")).toBe("in-sync");
  });

  test("a file created with different content on both sides conflicts", () => {
    expect(stateOf({}, { "new.txt": "h1" }, { "new.txt": "h2" }, "new.txt")).toBe("conflict");
  });
});

describe("aggregateState", () => {
  const files = (states: Record<string, SyncState>) =>
    Object.entries(states).map(([path, state]) => ({ path, state }));

  test("all in-sync stays in-sync", () => {
    expect(aggregateState(files({ "a.txt": "in-sync", "b.txt": "in-sync" }))).toBe("in-sync");
  });

  test("a conflict anywhere wins", () => {
    expect(
      aggregateState(files({ "a.txt": "muse-changed", "b.txt": "conflict" })),
    ).toBe("conflict");
  });

  test("muse-changed outranks local-changed", () => {
    expect(
      aggregateState(files({ "a.txt": "local-changed", "b.txt": "muse-changed" })),
    ).toBe("muse-changed");
  });

  test("local changes alone give local-changed", () => {
    expect(
      aggregateState(files({ "a.txt": "in-sync", "b.txt": "local-changed" })),
    ).toBe("local-changed");
  });
});
