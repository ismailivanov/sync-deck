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
    return "Sync Deck";
  }

  getIcon() {
    return ICON_ID;
  }

  async onOpen() {
    this.render();
    this.plugin.fetchVaultMembers();
    // Keep the member list live-ish while the panel is open so an admin sees
    // workers join and a removed worker's own panel updates promptly.
    this.membersTimer = window.setInterval(() => this.plugin.fetchVaultMembers(), 8000);
  }

  async onClose() {
    if (this.membersTimer) {
      window.clearInterval(this.membersTimer);
      this.membersTimer = null;
    }
  }

  render() {
    const data = this.plugin.data;
    this.contentEl.replaceChildren();
    this.contentEl.addClass("sd-root");

    const toolbar = createElement("div", "sd-toolbar");
    const title = createElement("div", "sd-toolbar-title");
    title.append(createElement("h2", "", "Sync Deck"));
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
    layout.append(this.renderSyncPanel(), this.renderMembersPanel(), this.renderActivityPanel());
    this.contentEl.append(toolbar, layout);
  }

  statusPill(text, tone) {
    return createElement("span", `sd-status-pill is-${tone}`, text);
  }

  renderSyncPanel() {
    const data = this.plugin.data;
    const stats = data.vaultStats;
    const panel = this.panel("Vault Sync", "cloud", "sd-panel-sync");
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

    panel.append(status, progress, rules, this.renderStorageSection(), actions);
    return panel;
  }

  renderStorageSection() {
    const data = this.plugin.data;
    const used = Math.max(0, Number(data.storageUsedMb) || 0);
    const limit = Number(data.storageLimitMb) > 0 ? Number(data.storageLimitMb) : 250;
    const fileMb = Number(data.fileLimitMb) > 0 ? Number(data.fileLimitMb) : 10;
    const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
    const pct = Math.round(ratio * 100);
    const isPro = data.plan === "pro";

    const wrap = createElement("div", "sd-storage");
    const head = createElement("div", "sd-storage-head");
    head.append(createElement("span", "sd-storage-label", "Storage"));
    head.append(createElement("span", `sd-plan-badge is-${isPro ? "pro" : "free"}`, isPro ? "Pro" : "Free"));
    wrap.append(head);

    const bar = createElement("div", "sd-storage-bar");
    const fill = createElement("div", "sd-storage-fill");
    fill.style.width = `${pct}%`;
    if (ratio >= 0.9) fill.classList.add("is-full");
    else if (ratio >= 0.7) fill.classList.add("is-warn");
    bar.append(fill);
    wrap.append(bar);

    wrap.append(createElement("div", "sd-storage-meta", `${used} MB of ${limit} MB used · ${fileMb} MB/file`));

    if (data.storageBlocked) {
      wrap.append(createElement(
        "div",
        "sd-storage-warn",
        data.storageBlockedReason === "server_full"
          ? "Sync paused — the server is temporarily full. Your changes are safe locally and will upload later."
          : "Sync paused — storage limit reached. Free up space or upgrade to Pro to keep syncing."
      ));
    } else if (!isPro && ratio >= 0.8) {
      wrap.append(createElement("div", "sd-storage-hint", "Almost full — upgrade to Pro for more space."));
    }

    // Upgrade CTA for Free users (only when billing is live on the server).
    if (!isPro && data.billingEnabled) {
      const upgrade = textButton("sparkles", "Upgrade to Pro", () => this.plugin.startUpgrade());
      upgrade.classList.add("sd-upgrade-btn");
      wrap.append(upgrade);
    }
    return wrap;
  }

  renderActivityPanel() {
    const panel = this.panel("Recent Activity", "radio", "sd-panel-activity");
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

  renderMembersPanel() {
    const data = this.plugin.data;
    const panel = this.panel("Vault Members", "users", "sd-panel-members");

    if (!data.signedIn) {
      const empty = createElement("div", "sd-empty-state");
      empty.append(
        createElement("strong", "", "Sign in to see members"),
        createElement("span", "", "Members appear once you sign in and join or create a vault.")
      );
      panel.append(empty);
      return panel;
    }

    const isAdmin = (data.role || "") === "Admin";
    panel.append(createElement(
      "p",
      "sd-members-note",
      isAdmin
        ? "You are an Admin. You can invite people and remove members."
        : "You are a Worker. You can sync this vault and see everyone in it."
    ));

    const members = Array.isArray(data.members) ? data.members : [];
    if (!members.length) {
      const empty = createElement("div", "sd-empty-state");
      empty.append(
        createElement("strong", "", "No members yet"),
        createElement("span", "", "Use Invite to share a code, or Join to enter a vault.")
      );
      panel.append(empty);
      return panel;
    }

    const list = createElement("div", "sd-member-list");
    members.forEach((member) => {
      const row = createElement("div", "sd-member-row");

      const main = createElement("div", "sd-member-main");
      main.append(this.avatar(member, "sd-member-avatar"));
      const info = createElement("div", "sd-member-info");
      const isYou = member.email === data.user.email;
      info.append(createElement("strong", "", (member.name || member.email) + (isYou ? " (you)" : "")));
      info.append(createElement("span", "sd-member-email", member.email));
      main.append(info);

      const side = createElement("div", "sd-member-side");
      const role = member.role === "Admin" ? "Admin" : "Worker";
      side.append(createElement("span", `sd-role-badge is-${role.toLowerCase()}`, role));

      const isOwner = data.vaultOwner && member.email === data.vaultOwner;
      if (isAdmin && !isOwner && !isYou) {
        side.append(textButton("user-minus", "Remove", () => this.confirmRemoveMember(member), "sd-member-remove"));
      }

      row.append(main, side);
      list.append(row);
    });

    panel.append(list);
    return panel;
  }

  confirmRemoveMember(member) {
    const name = member.name || member.email;
    const confirmed = window.confirm(`Remove ${name} from this vault?\n\nThey will lose sync access and the vault will disappear from their Sync Deck. They can rejoin only with a new invite.`);
    if (confirmed) this.plugin.removeVaultMember(member.email);
  }

  panel(title, icon, variant = "") {
    const panel = createElement("section", `sd-panel ${variant}`.trim());
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
