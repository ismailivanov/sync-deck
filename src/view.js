const { ItemView } = require("obsidian");
const {
  ICON_ID,
  VIEW_TYPE,
  createElement,
  formatBytes,
  iconBadge,
  initials,
  percent,
  textButton,
} = require("./helpers");

class SyncDeckView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "SyncDeck";
  }

  getIcon() {
    return ICON_ID;
  }

  async onOpen() {
    this.render();
  }

  render() {
    const data = this.plugin.data;
    this.contentEl.replaceChildren();
    this.contentEl.addClass("sd-root");

    const toolbar = createElement("div", "sd-toolbar");
    const title = createElement("div", "sd-toolbar-title");
    title.append(createElement("h2", "", "SyncDeck"));
    title.append(this.statusPill(data.serverStatus === "online" ? "API online" : "API offline", data.serverStatus === "online" ? "good" : "muted"));
    if (data.signedIn) title.append(this.avatar(data.user, "sd-profile-avatar"));

    const actions = createElement("div", "sd-toolbar-actions");
    actions.append(
      textButton(data.signedIn ? "log-out" : "log-in", data.signedIn ? "Sign out" : "Continue with Google", () => {
        if (data.signedIn) this.plugin.signOut();
        else this.plugin.signIn();
      }, data.signedIn ? "" : "mod-cta"),
      textButton("refresh-cw", data.syncEnabled ? "Pause sync" : "Start sync", () => this.plugin.toggleSync())
    );
    toolbar.append(title, actions);

    const layout = createElement("div", "sd-layout");
    layout.append(this.renderSyncPanel(), this.renderActivityPanel());
    this.contentEl.append(toolbar, layout);
  }

  statusPill(text, tone) {
    return createElement("span", `sd-status-pill is-${tone}`, text);
  }

  renderSyncPanel() {
    const data = this.plugin.data;
    const stats = data.vaultStats;
    const panel = this.panel("Vault Sync", "cloud");
    const hasSyncedFiles = (stats.syncedFiles || 0) > 0;
    const progressLabel = data.syncEnabled || hasSyncedFiles ? percent(data.syncProgress) : "Ready";
    const progressWidth = data.syncEnabled || hasSyncedFiles ? percent(data.syncProgress) : "0%";
    const statusText = data.syncEnabled
      ? `${stats.syncedFiles || 0} / ${stats.syncableFiles} files synced`
      : `${stats.syncableFiles} files ready to sync`;
    const progress = createElement("div", "sd-progress");
    const fill = createElement("div", "sd-progress-fill");
    fill.style.width = progressWidth;
    progress.append(fill);

    const status = createElement("div", "sd-sync-status");
    status.append(
      createElement("strong", "", progressLabel),
      createElement("span", "", statusText)
    );

    const rules = createElement("div", "sd-rule-list");
    [
      `${stats.syncableFiles} files`,
      formatBytes(stats.syncableBytes),
      `${stats.syncedFiles || 0} synced`,
      data.lastSync ? `Last sync ${data.lastSync}` : "Not synced yet",
    ].forEach((item) => {
      rules.append(this.rule(item));
    });

    const actions = createElement("div", "sd-panel-actions");
    actions.append(
      textButton("scan-line", "Scan now", () => this.plugin.finishScan()),
      textButton("cloud-download", "Pull latest", () => this.plugin.pullLatest()),
      textButton("user-plus", "Invite", () => this.plugin.createInvite()),
      textButton("key-round", "Join", () => this.plugin.joinInvite())
    );

    panel.append(status, progress, rules, actions);
    return panel;
  }

  renderActivityPanel() {
    const panel = this.panel("Recent Activity", "radio");
    const list = createElement("div", "sd-activity-list");
    const queue = this.plugin.data.syncQueue || [];

    if (!queue.length) {
      const empty = createElement("div", "sd-empty-state");
      empty.append(createElement("strong", "", "No queued changes"), createElement("span", "", "Run a scan or edit a file while sync is active."));
      panel.append(empty);
      return panel;
    }

    queue.slice(0, 6).forEach((item) => {
      const row = createElement("div", "sd-activity-row");
      const marker = createElement("span", "sd-cursor-marker");
      marker.style.backgroundColor = item.status === "done" ? "#22c55e" : "#8b5cf6";
      const copy = createElement("div", "sd-activity-copy");
      const meta = `${item.action} - ${item.status} - ${item.time}`;
      copy.append(createElement("strong", "", item.path), createElement("span", "", meta));
      row.append(marker, copy);
      list.append(row);
    });

    panel.append(list);
    return panel;
  }

  panel(title, icon) {
    const panel = createElement("section", "sd-panel");
    const header = createElement("div", "sd-panel-header");
    header.append(createElement("h3", "", title), iconBadge(icon, title));
    panel.append(header);
    return panel;
  }

  avatar(person, className = "sd-avatar") {
    const avatar = createElement("span", className);
    avatar.style.backgroundColor = person.color || "#8b5cf6";

    if (person.picture) {
      const image = document.createElement("img");
      image.src = person.picture;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent = initials(person.name || person.email);
    }

    return avatar;
  }

  rule(text) {
    const item = createElement("span", "sd-rule");
    item.append(createElement("span", "sd-rule-dot"), createElement("span", "", text));
    return item;
  }
}

module.exports = { SyncDeckView };
