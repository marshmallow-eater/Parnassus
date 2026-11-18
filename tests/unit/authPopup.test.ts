import { describe, expect, test } from "bun:test";
import {
  chromeUserAgent,
  isPopupAllowed,
  MUSE_PARTITION,
  POPUP_ZOOM_FACTOR,
  popupWindowSize,
} from "../../src/main/authPopup";

describe("isPopupAllowed", () => {
  test("allows the Muse site itself", () => {
    expect(isPopupAllowed("https://muse.ai/login")).toBe(true);
    expect(isPopupAllowed("https://www.muse.ai/")).toBe(true);
  });

  test("allows Facebook login hosts", () => {
    expect(isPopupAllowed("https://www.facebook.com/v19.0/dialog/oauth")).toBe(true);
    expect(isPopupAllowed("https://facebook.com/login")).toBe(true);
    expect(isPopupAllowed("https://m.facebook.com/dialog/oauth")).toBe(true);
  });

  test("allows the other sign-in providers Muse offers", () => {
    expect(isPopupAllowed("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isPopupAllowed("https://appleid.apple.com/auth/authorize")).toBe(true);
  });

  test("does not allow unrelated sites as in-app popups", () => {
    expect(isPopupAllowed("https://example.com/")).toBe(false);
    expect(isPopupAllowed("https://facebook.com.evil.example/")).toBe(false);
    expect(isPopupAllowed("https://notfacebook.com/")).toBe(false);
  });

  test("rejects non-https and malformed URLs", () => {
    expect(isPopupAllowed("http://www.facebook.com/login")).toBe(false);
    expect(isPopupAllowed("file:///etc/passwd")).toBe(false);
    expect(isPopupAllowed("not a url")).toBe(false);
    expect(isPopupAllowed("")).toBe(false);
  });
});

describe("chromeUserAgent", () => {
  test("looks like plain Chrome with no Electron or app tokens", () => {
    const ua = chromeUserAgent("140.0.0.0");
    expect(ua).toContain("Chrome/140.0.0.0");
    expect(ua).not.toContain("Electron");
    expect(ua).not.toContain("Parnassus");
  });

  test("the Muse webview session is persistent", () => {
    expect(MUSE_PARTITION.startsWith("persist:")).toBe(true);
  });
});

describe("popupWindowSize", () => {
  test("fills the whole work area: the popup opens maximised", () => {
    expect(popupWindowSize(1920, 1040)).toEqual({ width: 1920, height: 1040 });
    expect(popupWindowSize(1280, 800)).toEqual({ width: 1280, height: 800 });
  });

  test("the popup page renders at 100% zoom", () => {
    expect(POPUP_ZOOM_FACTOR).toBe(1.0);
  });
});
