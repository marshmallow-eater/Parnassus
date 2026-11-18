import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import "@astryxdesign/theme-neutral/theme.css";

// Parnassus theme: the neutral theme with near-black surfaces for dark mode.
// Every value is an Astryx token (a CSS custom property); token tuples are
// [light, dark]. The app always runs in dark mode, but the light values keep
// the theme valid if the mode ever changes. Color elsewhere in the UI is
// reserved for sync-state meaning: neutral, blue, amber, red.
export const parnassusTheme = defineTheme({
  name: "parnassus",
  extends: neutralTheme,
  tokens: {
    "--color-background-body": ["#f4f4f1", "#0a0b0c"],
    "--color-background-surface": ["#ffffff", "#101112"],
    "--color-background-card": ["#ffffff", "#141518"],
    "--color-background-muted": ["#ebebe7", "#1b1c1f"],
    "--color-background-popover": ["#ffffff", "#17181b"],
    "--color-border": ["#d9d9d4", "#232428"],
    "--color-border-emphasized": ["#b9b9b2", "#33343a"],
  },
});
