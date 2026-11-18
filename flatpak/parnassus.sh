#!/bin/sh
# Launcher for the Flatpak build. The electron-builder tarball unpacks to a
# versioned folder (parnassus-<version>) holding the parnassus binary; run
# it under zypak, the sandbox wrapper the Electron base app provides.
exec zypak-wrapper /app/parnassus-*/parnassus "$@"
