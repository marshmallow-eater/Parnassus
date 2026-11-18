import { describe, expect, test } from "bun:test";
import { projectFromPath } from "../../src/shared/project";

describe("projectFromPath", () => {
  test("names the project after its folder on POSIX and Windows paths", () => {
    expect(projectFromPath("/home/user/field-notes").name).toBe("field-notes");
    expect(projectFromPath("C:\\Users\\user\\field-notes").name).toBe("field-notes");
    expect(projectFromPath("/home/user/field-notes/").name).toBe("field-notes");
  });

  test("the same folder maps to the same id everywhere", () => {
    expect(projectFromPath("/home/user/field-notes").id).toBe(
      projectFromPath("/home/user/field-notes").id,
    );
    expect(projectFromPath("/home/user/other").id).not.toBe(
      projectFromPath("/home/user/field-notes").id,
    );
  });
});
