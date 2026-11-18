import type { FileBridge } from "@shared/bridge";
import { MockBridge } from "./mockBridge";

declare global {
  interface Window {
    museBridge?: FileBridge;
    __mockBridge?: MockBridge;
  }
}

// In Electron the preload exposes window.museBridge and every call goes to
// the main process. In a plain browser there is no preload, so the renderer
// falls back to the in-memory mock. The UI code below this module cannot
// tell the two apart.
export function getBridge(): FileBridge {
  if (window.museBridge) return window.museBridge;
  const mock = new MockBridge();
  window.__mockBridge = mock;
  return mock;
}

export function isElectron(): boolean {
  return window.museBridge !== undefined;
}
