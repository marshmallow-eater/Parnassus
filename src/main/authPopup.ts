// Sign-in popup policy for the embedded muse.ai view. Pure helpers (no
// Electron imports) so the policy is unit-testable.

// The webview and every sign-in popup share this session. It must be
// persistent or the cookies set during a provider round-trip (Facebook,
// Google, Apple) are gone before muse.ai can read them, and the user is
// bounced back to the login screen.
export const MUSE_PARTITION = "persist:muse";

// Hosts allowed to open as in-app popups: muse.ai itself and the identity
// providers its login page sends the user to. Anything else opens in the
// system browser instead.
const POPUP_HOSTS = ["muse.ai", "facebook.com", "meta.com", "accounts.google.com", "appleid.apple.com"];

export function isPopupAllowed(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return POPUP_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// Sign-in pages are tall (form, password, 2FA, consent) and were clipped
// by a fixed short popup. The popup opens maximised at 100% zoom, so its
// size is the full work area of the screen it opens on.
export const POPUP_ZOOM_FACTOR = 1.0;

export function popupWindowSize(
  workAreaWidth: number,
  workAreaHeight: number,
): { width: number; height: number } {
  return { width: workAreaWidth, height: workAreaHeight };
}

// Identity providers reject embedded-browser user agents that advertise
// Electron ("This browser or app may not be secure"). Present the plain
// Chrome the bundled Chromium actually is, built from its real version.
export function chromeUserAgent(
  chromeVersion: string,
  platform = "X11; Linux x86_64",
): string {
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}
