// Login-state detection for the embedded muse.ai page. Projects stay
// hidden until this says the user is signed in, and it fails closed:
// anything unrecognised counts as signed out.

export interface MusePageSignals {
  url: string;
  /** The sign-in form (email/phone field, provider buttons) is on the page. */
  hasLoginForm: boolean;
  /** A chat message composer is on the page. */
  hasComposer: boolean;
  /** Signed-in app chrome (conversation list, log out, profile) is present. */
  hasAppShell: boolean;
  /** Guest viewport size, for detecting when it stops matching its element. */
  viewWidth?: number;
  viewHeight?: number;
}

const AUTH_PATHS = ["/login", "/auth", "/signin", "/sign-in", "/signup", "/sign-up"];

export function isMuseLoggedIn(signals: MusePageSignals): boolean {
  let url: URL;
  try {
    url = new URL(signals.url);
  } catch {
    return false;
  }
  // Sign-in happens on muse.ai itself; provider pages (Facebook, Meta,
  // Google) and muse.ai's own auth routes are by definition signed out.
  if (url.hostname !== "muse.ai" && !url.hostname.endsWith(".muse.ai")) return false;
  const path = url.pathname.toLowerCase();
  if (AUTH_PATHS.some((authPath) => path === authPath || path.startsWith(`${authPath}/`))) {
    return false;
  }
  if (signals.hasLoginForm) return false;
  return signals.hasComposer || signals.hasAppShell;
}
