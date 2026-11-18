import { describe, expect, test } from "bun:test";
import { isMuseLoggedIn, type MusePageSignals } from "../../src/shared/museAuth";

function signals(partial: Partial<MusePageSignals>): MusePageSignals {
  return {
    url: "https://muse.ai/",
    hasLoginForm: false,
    hasComposer: false,
    hasAppShell: false,
    ...partial,
  };
}

describe("isMuseLoggedIn", () => {
  test("the logged-out landing/login page is not logged in", () => {
    expect(isMuseLoggedIn(signals({ hasLoginForm: true }))).toBe(false);
  });

  test("a chat composer means logged in", () => {
    expect(isMuseLoggedIn(signals({ hasComposer: true }))).toBe(true);
  });

  test("the app shell (conversations, log out) means logged in", () => {
    expect(isMuseLoggedIn(signals({ hasAppShell: true }))).toBe(true);
  });

  test("a login form wins over any app-like signal", () => {
    expect(isMuseLoggedIn(signals({ hasLoginForm: true, hasComposer: true }))).toBe(false);
  });

  test("unknown pages fail closed: not logged in", () => {
    expect(isMuseLoggedIn(signals({}))).toBe(false);
  });

  test("provider and auth pages are not logged in", () => {
    expect(
      isMuseLoggedIn(signals({ url: "https://www.facebook.com/dialog/oauth", hasComposer: true })),
    ).toBe(false);
    expect(isMuseLoggedIn(signals({ url: "https://muse.ai/login", hasComposer: true }))).toBe(
      false,
    );
    expect(isMuseLoggedIn(signals({ url: "not a url", hasComposer: true }))).toBe(false);
  });
});
