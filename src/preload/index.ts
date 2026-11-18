import { contextBridge, ipcRenderer } from "electron";
import type { FileBridge } from "../shared/bridge";

// Exposes the FileBridge as window.museBridge. The renderer holds no fs
// access of its own; every call crosses to the main process over IPC.
const bridge: FileBridge = {
  pickFolder: () => ipcRenderer.invoke("bridge:pickFolder"),
  scanProject: (project) => ipcRenderer.invoke("bridge:scanProject", project),
  copyIn: (project, includeExtraPaths) =>
    ipcRenderer.invoke("bridge:copyIn", project, includeExtraPaths),
  listProjects: () => ipcRenderer.invoke("bridge:listProjects"),
  reconcile: (projectId) => ipcRenderer.invoke("bridge:reconcile", projectId),
  readFile: (projectId, path, side) =>
    ipcRenderer.invoke("bridge:readFile", projectId, path, side),
  stageEdit: (projectId, path) => ipcRenderer.invoke("bridge:stageEdit", projectId, path),
  saveBack: (projectId, resolutions) =>
    ipcRenderer.invoke("bridge:saveBack", projectId, resolutions),
  getGenericProfile: () => ipcRenderer.invoke("bridge:getGenericProfile"),
  setGenericProfile: (profile) => ipcRenderer.invoke("bridge:setGenericProfile", profile),
  setProjectProfile: (projectId, profile) =>
    ipcRenderer.invoke("bridge:setProjectProfile", projectId, profile),
  setProjectChatUrl: (projectId, chatUrl) =>
    ipcRenderer.invoke("bridge:setProjectChatUrl", projectId, chatUrl),
  describeFiles: (projectId) => ipcRenderer.invoke("bridge:describeFiles", projectId),
  applySync: (projectId, directions) =>
    ipcRenderer.invoke("bridge:applySync", projectId, directions),
  getProjectKnowledge: (projectId) =>
    ipcRenderer.invoke("bridge:getProjectKnowledge", projectId),
  setProjectKnowledge: (projectId, knowledge) =>
    ipcRenderer.invoke("bridge:setProjectKnowledge", projectId, knowledge),
};

contextBridge.exposeInMainWorld("museBridge", bridge);
