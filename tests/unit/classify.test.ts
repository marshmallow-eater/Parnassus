import { describe, expect, test } from "bun:test";
import { isJunkPath, matchGitignore, sniffClass } from "../../src/shared/classify";

const bytes = (...nums: number[]) => new Uint8Array(nums);
const text = (s: string) => new TextEncoder().encode(s);

describe("sniffClass", () => {
  test("PNG magic is readable-binary", () => {
    expect(sniffClass(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      "readable-binary",
    );
  });

  test("PDF magic is readable-binary", () => {
    expect(sniffClass(text("%PDF-1.7\nsome body"))).toBe("readable-binary");
  });

  test("ZIP magic is readable-binary (office documents are zip files)", () => {
    expect(sniffClass(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe("readable-binary");
  });

  test("JPEG magic is readable-binary", () => {
    expect(sniffClass(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("readable-binary");
  });

  test("ELF magic is opaque-binary", () => {
    expect(sniffClass(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00))).toBe(
      "opaque-binary",
    );
  });

  test("MZ magic is opaque-binary", () => {
    expect(sniffClass(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00))).toBe("opaque-binary");
  });

  test("WebAssembly magic is opaque-binary", () => {
    expect(sniffClass(bytes(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00))).toBe("opaque-binary");
  });

  test("plain text is text", () => {
    expect(sniffClass(text("# Notes\nhello world\n"))).toBe("text");
  });

  test("no known magic but a NUL byte means opaque-binary", () => {
    const sample = new Uint8Array([0x41, 0x42, 0x00, 0x43, 0x44]);
    expect(sniffClass(sample)).toBe("opaque-binary");
  });

  test("empty input is text", () => {
    expect(sniffClass(new Uint8Array(0))).toBe("text");
  });
});

describe("isJunkPath", () => {
  test("node_modules anywhere in the path is junk", () => {
    expect(isJunkPath("node_modules/left-pad/index.js")).toBe(true);
    expect(isJunkPath("packages/a/node_modules/x.js")).toBe(true);
  });

  test("VCS internals and build outputs are junk", () => {
    expect(isJunkPath(".git/config")).toBe(true);
    expect(isJunkPath("dist/bundle.js")).toBe(true);
    expect(isJunkPath(".cache/entry")).toBe(true);
  });

  test("ordinary source and note files are not junk", () => {
    expect(isJunkPath("src/main.ts")).toBe(false);
    expect(isJunkPath("notes.txt")).toBe(false);
    expect(isJunkPath("building-plans.md")).toBe(false);
  });

  test("OS droppings are junk", () => {
    expect(isJunkPath(".DS_Store")).toBe(true);
    expect(isJunkPath("photos/.DS_Store")).toBe(true);
  });
});

describe("matchGitignore", () => {
  test("extension glob matches a basename at top level", () => {
    expect(matchGitignore(["*.log"], "debug.log")).toBe(true);
    expect(matchGitignore(["*.log"], "notes.txt")).toBe(false);
  });

  test("slash-free patterns match at any depth", () => {
    expect(matchGitignore(["*.log"], "logs/debug.log")).toBe(true);
  });

  test("directory patterns match the directory segment", () => {
    expect(matchGitignore(["dist/"], "dist/bundle.js")).toBe(true);
    expect(matchGitignore(["dist/"], "src/dist-utils/x.js")).toBe(false);
  });

  test("anchored patterns only match at the root", () => {
    expect(matchGitignore(["/root.txt"], "root.txt")).toBe(true);
    expect(matchGitignore(["/root.txt"], "sub/root.txt")).toBe(false);
  });

  test("comments, blanks and negations do not match", () => {
    expect(matchGitignore(["# a comment", "", "!keep.log"], "keep.log")).toBe(false);
  });
});
