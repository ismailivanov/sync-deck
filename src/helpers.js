const { setIcon } = require("obsidian");

const VIEW_TYPE = "sync-deck-view";
const ICON_ID = "sync-deck";
const ICON_SVG = `
  <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="16" y="20" width="30" height="24" rx="5" />
    <rect x="54" y="20" width="30" height="24" rx="5" />
    <rect x="35" y="56" width="30" height="24" rx="5" />
    <path d="M46 32h8" />
    <path d="M50 44v12" />
  </g>
`;
const MAX_SYNC_FILE_SIZE = 10 * 1024 * 1024;
const IGNORE_PREFIXES = [".git/", ".trash/", "node_modules/", ".obsidian/cache/", ".obsidian/plugins/"];
const IGNORE_PATHS = [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"];
const DEMO_MEMBER_EMAILS = new Set(["ismail@example.com", "maya@example.com", "deniz@example.com"]);

const DEFAULT_DATA = {
  signedIn: false,
  deviceId: "",
  vaultId: "",
  serverUrl: "https://api.syncdeck.cloud",
  authToken: "",
  serverStatus: "offline",
  user: {
    name: "Ismail Ivanov",
    email: "ismail@example.com",
    picture: "",
    color: "#8b5cf6",
  },
  workspace: "Aircraft Team",
  role: "Admin",
  vaultOwner: "",
  syncEnabled: false,
  syncProgress: 0,
  remoteUpdatedAt: "",
  lastSync: "",
  storageUsedMb: 0,
  storageLimitMb: 100,
  plan: "free",
  boardLimit: 1,
  storageBlocked: false,
  storageBlockedReason: "",
  vaultStats: {
    totalFiles: 0,
    syncableFiles: 0,
    syncedFiles: 0,
    markdownFiles: 0,
    binaryFiles: 0,
    taskDeckFiles: 0,
    ignoredFiles: 0,
    oversizedFiles: 0,
    totalBytes: 0,
    syncableBytes: 0,
    syncedBytes: 0,
  },
  syncQueue: [],
  recentFiles: [],
  members: [],
  activity: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function iconSlot(icon) {
  const slot = createElement("span", "sd-button-icon");
  try {
    setIcon(slot, icon);
  } catch (error) {
    slot.textContent = "";
  }
  return slot;
}

function textButton(icon, label, onClick, className = "") {
  const button = createElement("button", `sd-text-button ${className}`.trim());
  button.type = "button";
  button.append(iconSlot(icon), createElement("span", "", label));
  button.addEventListener("click", onClick);
  return button;
}

function iconBadge(icon, label) {
  const badge = createElement("span", "sd-icon-badge");
  badge.title = label;
  badge.append(iconSlot(icon));
  return badge;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "?";
}

function percent(value) {
  return `${Math.max(0, Math.min(100, Math.round(value || 0)))}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function isIgnoredPath(path) {
  return IGNORE_PATHS.includes(path) || IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isMarkdownPath(path) {
  return /\.md$/i.test(path);
}

module.exports = {
  DEFAULT_DATA,
  DEMO_MEMBER_EMAILS,
  ICON_ID,
  ICON_SVG,
  IGNORE_PREFIXES,
  IGNORE_PATHS,
  MAX_SYNC_FILE_SIZE,
  VIEW_TYPE,
  clone,
  createElement,
  formatBytes,
  iconBadge,
  initials,
  isIgnoredPath,
  isMarkdownPath,
  percent,
  textButton,
  uid,
};
