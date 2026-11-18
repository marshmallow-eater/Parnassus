import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { join } from "node:path";
import type { FileBridge } from "../shared/bridge";
import {
  chromePlatformToken,
  chromeUserAgent,
  isPopupAllowed,
  MUSE_PARTITION,
  POPUP_ZOOM_FACTOR,
  popupWindowSize,
} from "./authPopup";
import { NodeFileBridge } from "./realBridge";

const HOTKEY = "CommandOrControl+Shift+M";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function toggleWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: "Parnassus",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });
  // The embedded muse.ai page is a full desktop site: start maximised so
  // it is not squeezed into the default window minus the projects pane.
  mainWindow.maximize();
  mainWindow.show();
  // Closing the window hides it to the tray; quitting happens from the tray
  // menu or the OS quit command, so the app stays one hotkey away.
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function createTray(): void {
  const iconPath = join(app.getAppPath(), "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  tray = new Tray(icon.resize({ width: 32, height: 32 }));
  tray.setToolTip("Parnassus");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Parnassus", click: toggleWindow },
      { type: "separator" },
      {
        label: "Quit Parnassus",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", toggleWindow);
}

function registerBridge(bridge: FileBridge): void {
  const names: (keyof FileBridge)[] = [
    "pickFolder",
    "scanProject",
    "copyIn",
    "listProjects",
    "reconcile",
    "readFile",
    "stageEdit",
    "saveBack",
    "getGenericProfile",
    "setGenericProfile",
    "setProjectProfile",
    "getProjectKnowledge",
    "setProjectKnowledge",
    "setProjectChatUrl",
    "describeFiles",
    "applySync",
  ];
  for (const name of names) {
    ipcMain.handle(`bridge:${name}`, (_event, ...args: unknown[]) =>
      (bridge[name] as (...a: unknown[]) => unknown)(...args),
    );
  }
}

function configureMuseSession(): void {
  // The General chat's persistent session, presenting as plain Chrome so
  // providers do not reject it as an insecure embedded browser. Each
  // project's chat has its own partition (see chatSession.ts); those
  // sessions are configured the same way when their webview is created.
  session.fromPartition(MUSE_PARTITION).setUserAgent(chromeUserAgent(process.versions.chrome ?? "", chromePlatformToken(process.platform)));
}

// Best-effort sign-in carry-over for a project's isolated chat session:
// copy the Muse cookies from the General (sign-in) session into the
// project's fresh partition, so isolating the chat does not by itself
// sign the user out. Storage-only sign-in state cannot be copied this
// way; then the project's chat shows its own sign-in, in its partition.
async function seedAuthCookies(guest: Electron.Session): Promise<void> {
  const primary = session.fromPartition(MUSE_PARTITION);
  if (guest === primary) return;
  try {
    guest.setUserAgent(chromeUserAgent(process.versions.chrome ?? "", chromePlatformToken(process.platform)));
    const cookies = await primary.cookies.get({});
    for (const cookie of cookies) {
      const host = (cookie.domain ?? "").replace(/^\./, "");
      if (!host) continue;
      const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
      await guest.cookies
        .set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite,
        })
        .catch(() => {});
    }
  } catch {
    // No cookies yet (nobody signed in): the chat shows its sign-in.
  }
}

function handleGuestPopups(): void {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    // A project's chat lives in its own partition: give that session the
    // Chrome user agent and any Muse sign-in cookies General already has.
    void seedAuthCookies(contents.session);
    // A sign-in popup: open it maximised and zoom its page out, or the
    // tall login form is clipped on a short (scaled) display. This must
    // hook did-create-window: at web-contents-created time the popup's
    // BrowserWindow does not exist yet, so there is nothing to maximise.
    contents.on("did-create-window", (popup) => {
      popup.maximize();
      popup.webContents.on("did-finish-load", () => {
        popup.webContents.setZoomFactor(POPUP_ZOOM_FACTOR);
      });
    });
    // "Continue with Facebook" (and Google/Apple) signs in via
    // window.open. Without this handler the click opens nothing.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPopupAllowed(url)) {
        const { workArea } = screen.getPrimaryDisplay();
        const size = popupWindowSize(workArea.width, workArea.height);
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            x: workArea.x,
            y: workArea.y,
            width: size.width,
            height: size.height,
            minWidth: 480,
            minHeight: 560,
            resizable: true,
            autoHideMenuBar: true,
            webPreferences: {
              // The popup must share the session of the chat that opened
              // it (General's, or that project's own partition), or the
              // provider cookies land in the wrong isolated chat.
              session: contents.session,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          },
        };
      }
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
  });
}

app.whenReady().then(() => {
  configureMuseSession();
  handleGuestPopups();
  const bridge = new NodeFileBridge(
    join(app.getPath("userData"), "parnassus-data"),
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  registerBridge(bridge);
  createWindow();
  createTray();
  globalShortcut.register(HOTKEY, toggleWindow);
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// The tray owns the app's lifetime; an all-windows-closed event does not
// quit it.
app.on("window-all-closed", () => {});
