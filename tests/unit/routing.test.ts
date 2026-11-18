import { describe, expect, test } from "bun:test";
import { routeQuestion, type RoutingCandidate } from "../../src/shared/routing";

const fieldNotes: RoutingCandidate = {
  projectId: "p-field",
  name: "field-notes",
  goal: "Ship the field guide",
  soul: "Careful and direct",
  decisions: "Use the retry helper in api files",
  memory: "In notes.txt, dates are day-first",
  fileNames: ["notes.txt", "README.md"],
};

const photos: RoutingCandidate = {
  projectId: "p-photos",
  name: "photos",
  goal: "Organize the photo archive",
  soul: "Patient",
  decisions: null,
  memory: "Albums are named by year",
  fileNames: ["img-001.png"],
};

describe("routeQuestion", () => {
  test("a question naming the project routes there", () => {
    const result = routeQuestion("what is left in field-notes?", [fieldNotes, photos]);
    expect(result.best?.projectId).toBe("p-field");
    expect(result.best?.reasons.join(" ")).toContain("name");
  });

  test("goal and memory keywords route without the project name", () => {
    const result = routeQuestion("how should dates be written in notes.txt?", [fieldNotes, photos]);
    expect(result.best?.projectId).toBe("p-field");
  });

  test("a topic from another project's memory routes there", () => {
    const result = routeQuestion("how are albums named by year?", [fieldNotes, photos]);
    expect(result.best?.projectId).toBe("p-photos");
  });

  test("an unrelated question has no clear home", () => {
    const result = routeQuestion("what is the weather tomorrow?", [fieldNotes, photos]);
    expect(result.best).toBeNull();
  });

  test("empty candidates and empty question route nowhere", () => {
    expect(routeQuestion("anything", []).best).toBeNull();
    expect(routeQuestion("   ", [fieldNotes]).best).toBeNull();
  });
});
