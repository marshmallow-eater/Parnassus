import { describe, expect, test } from "bun:test";
import {
  DECISIONS_FILE,
  DECISIONS_TEMPLATE,
  MEMORY_FILE,
  MEMORY_TEMPLATE,
} from "../../src/shared/knowledge";
import { PROFILE_DIR } from "../../src/shared/profile";

describe("project knowledge files", () => {
  test("live in the .parnassus folder with stable names", () => {
    expect(PROFILE_DIR).toBe(".parnassus");
    expect(DECISIONS_FILE).toBe("decisions.md");
    expect(MEMORY_FILE).toBe("memory.md");
  });

  test("templates state what each file is for", () => {
    expect(DECISIONS_TEMPLATE).toContain("# Decisions");
    expect(MEMORY_TEMPLATE).toContain("# Project memory");
    expect(MEMORY_TEMPLATE.toLowerCase()).toContain("certain files");
  });
});
