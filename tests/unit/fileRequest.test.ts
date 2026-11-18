import { describe, expect, test } from "bun:test";
import {
  FILE_REQUEST_MARKER,
  latestFileRequest,
  parseFileRequests,
} from "../../src/shared/fileRequest";

describe("parseFileRequests", () => {
  test("finds file requests the agent makes, in order", () => {
    const text = [
      "Let me look at that.",
      `${FILE_REQUEST_MARKER} notes.txt`,
      "Thanks, now the API file:",
      "PARNASSUS_FILE_REQUEST: src/api.ts",
    ].join("\n");
    expect(parseFileRequests(text)).toEqual(["notes.txt", "src/api.ts"]);
    expect(latestFileRequest(text)).toEqual({ path: "src/api.ts", occurrence: 2 });
  });

  test("ignores prose, absolute paths, and escapes out of the project", () => {
    const text = [
      "You could use PARNASSUS_FILE_REQUEST: to ask for a file",
      "PARNASSUS_FILE_REQUEST: /etc/passwd",
      "PARNASSUS_FILE_REQUEST: ../secret.txt",
      "PARNASSUS_FILE_REQUEST: src/../../secret.txt",
      "no request here",
    ].join("\n");
    expect(parseFileRequests(text)).toEqual([]);
    expect(latestFileRequest(text)).toBeNull();
    expect(latestFileRequest("")).toBeNull();
  });

  test("the same file requested again later counts as a new request", () => {
    const text = [
      "PARNASSUS_FILE_REQUEST: notes.txt",
      "answer one",
      "PARNASSUS_FILE_REQUEST: notes.txt",
    ].join("\n");
    expect(parseFileRequests(text)).toEqual(["notes.txt", "notes.txt"]);
    expect(latestFileRequest(text)).toEqual({ path: "notes.txt", occurrence: 2 });
  });
});
