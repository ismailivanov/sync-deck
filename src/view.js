const { ItemView } = require("obsidian");
const {
  ICON_ID,
  VIEW_TYPE,
  createElement,
  formatBytes,
  iconBadge,
  initials,
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
    this.plugin.fetchVaultList();
    // Keep the member list live-ish while the panel is open so an admin sees
    // workers join and a removed worker's own panel updates promptly.
    this.membersTimer = window.setInterval(() => this.plugin.fetchVaultMembers(), 8000);
    // First-run Pro offer (once), after plan/billing have had a moment to load.
    window.setTimeout(() => this.maybeShowOnboarding(), 800);
  }

  // Show the upgrade modal once for a new Free user (with a "Continue with Free"
  // escape). Only fires when billing is live so the buttons work; otherwise it
  // waits for a later open. Marked as shown only when actually presented.
  maybeShowOnboarding() {
    const d = this.plugin.data;
    if (d.onboarded) return;
    if (!d.signedIn || d.plan === "pro" || !d.billingEnabled) return;
    d.onboarded = true;
    this.plugin.savePluginData();
    this.plugin.openUpgradeModal();
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

    const shell = createElement("div", "sd-shell");
    shell.append(this.renderHeader());

    if (!this.plugin.hasAcceptedTerms()) {
      shell.append(this.renderTermsGate());
    } else if (!data.signedIn) {
      shell.append(this.renderSignedOut());
    } else if (!data.vaultInitialized) {
      // No vault open yet — a vault system: pick one to open, or create a new one.
      // Nothing is active at the top until a vault is opened.
      shell.append(this.renderNoVaultState(), this.renderVaultsSection());
    } else {
      shell.append(
        this.renderActiveVaultCard(),
        this.renderVaultsSection(),
        this.renderPeople(),
        this.renderActivity()
      );
    }

    shell.append(this.renderFooter());
    this.contentEl.append(shell);
  }

  renderFooter() {
    const footer = createElement("div", "sd-footer");
    footer.append(textButton("heart", "Support the developer", () => window.open("https://buymeacoffee.com/carbon06"), "sd-ghost-btn"));
    footer.append(textButton("book-open", "Guide", () => window.open("https://github.com/ismailivanov/SyncDeck"), "sd-ghost-btn"));
    return footer;
  }

  // ---- Header ---------------------------------------------------------------
  renderHeader() {
    const data = this.plugin.data;
    const header = createElement("div", "sd-header");

    const brand = createElement("div", "sd-brand");
    brand.append(createElement("span", "sd-brand-name", "Sync Deck"));
    const online = data.serverStatus === "online";
    const status = createElement("span", `sd-online is-${online ? "on" : "off"}`);
    status.append(createElement("span", "sd-online-dot"), createElement("span", "", online ? "Online" : "Offline"));
    brand.append(status);
    header.append(brand);

    const account = createElement("div", "sd-account");
    if (data.signedIn) {
      account.append(this.avatar(data.user, "sd-account-avatar"));
      account.append(textButton("log-out", "Sign out", () => this.plugin.signOut(), "sd-ghost-btn"));
    }
    header.append(account);
    return header;
  }

  renderTermsGate() {
    const wrap = createElement("div", "sd-card sd-signedout sd-terms");
    wrap.append(createElement("h3", "sd-signedout-title", "Terms & Privacy"));
    wrap.append(createElement("p", "sd-signedout-copy", "To use Sync Deck, please read and accept the Terms of Service and Privacy Notice."));
    wrap.append(textButton("external-link", "Read the Terms & Privacy Notice", () => this.plugin.openTermsPage(), "sd-ghost-btn sd-block-btn"));

    const row = createElement("label", "sd-terms-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    row.append(box, createElement("span", "", "I have read and agree to the Terms of Service and Privacy Notice."));
    wrap.append(row);

    const cont = textButton("check", "Continue", () => { if (box.checked) this.plugin.acceptTerms(); }, "sd-primary-btn sd-block-btn");
    cont.disabled = true;
    box.addEventListener("change", () => { cont.disabled = !box.checked; });
    wrap.append(cont);
    return wrap;
  }

  renderSignedOut() {
    const wrap = createElement("div", "sd-card sd-signedout");
    wrap.append(createElement("h3", "sd-signedout-title", "Sync your vault, everywhere"));
    wrap.append(createElement(
      "p",
      "sd-signedout-copy",
      "Sign in to sync this vault across your devices and with your team — with live presence, invites, and roles."
    ));
    wrap.append(textButton("log-in", "Continue with Google", () => this.plugin.signIn(), "sd-primary-btn sd-block-btn"));
    return wrap;
  }

  // Shown when no vault is open. Nothing syncs until the user creates or opens one.
  renderNoVaultState() {
    const data = this.plugin.data;
    const hasVaults = Array.isArray(data.vaultList) && data.vaultList.length > 0;
    const wrap = createElement("div", "sd-card sd-signedout");
    wrap.append(createElement("h3", "sd-signedout-title", hasVaults ? "No vault open" : "Create your first vault"));
    wrap.append(createElement(
      "p",
      "sd-signedout-copy",
      hasVaults
        ? "Open one of your vaults below, create a new one, or join a vault someone shared with you. Nothing syncs until you do."
        : "Create a vault to start syncing this Obsidian vault, or join one someone shared with you."
    ));
    wrap.append(textButton("plus", "Create a vault", () => this.plugin.createNewVault(), "sd-primary-btn sd-block-btn"));
    wrap.append(textButton("key-round", "Join a vault", () => this.plugin.joinInvite(), "sd-block-btn"));
    return wrap;
  }

  // ---- Active vault ---------------------------------------------------------
  syncState() {
    const d = this.plugin.data;
    if (d.storageBlocked) return { label: "Sync paused — storage full", tone: "danger" };
    if (!d.syncEnabled) return { label: "Sync paused", tone: "muted" };
    const p = Math.round(d.syncProgress || 0);
    if (p > 0 && p < 100) return { label: `Syncing… ${p}%`, tone: "accent", progress: p };
    return { label: d.lastSync ? "Up to date" : "Ready to sync", tone: "good" };
  }

  renderActiveVaultCard() {
    const data = this.plugin.data;
    const card = createElement("div", "sd-card sd-vault-card");

    // Name row + rename.
    const head = createElement("div", "sd-vc-head");
    const nameWrap = createElement("div", "sd-vc-name");
    nameWrap.append(iconBadge("folder", "Vault"));
    nameWrap.append(createElement("strong", "", data.workspace || "My vault"));
    const isPro = data.plan === "pro";
    nameWrap.append(createElement("span", `sd-plan-badge is-${isPro ? "pro" : "free"}`, isPro ? "Pro" : "Free"));
    head.append(nameWrap);
    const headActions = createElement("div", "sd-vc-head-actions");
    headActions.append(textButton("eye", "", () => this.plugin.inspectVault({ vaultId: data.vaultId, workspace: data.workspace }), "sd-icon-btn"));
    const ownsActive = !data.vaultOwner || data.vaultOwner === data.user.email;
    if ((data.role || "") === "Admin") {
      headActions.append(textButton("pencil", "", () => this.plugin.renameActiveVault(), "sd-icon-btn"));
    }
    if (ownsActive) {
      // Owner: close (stop syncing here, keep the vault) OR delete (remove for all).
      const ownerRef = { vaultId: data.vaultId, workspace: data.workspace, owner: data.vaultOwner || data.user.email };
      headActions.append(textButton("log-out", "", () => this.plugin.leaveVault(ownerRef), "sd-icon-btn"));
      headActions.append(textButton("trash-2", "", () => this.plugin.deleteVault(ownerRef), "sd-icon-btn sd-danger"));
    } else {
      // A member (worker) can leave the vault they joined; their local files stay.
      headActions.append(textButton("log-out", "", () => this.plugin.leaveVault({ vaultId: data.vaultId, workspace: data.workspace, owner: data.vaultOwner }), "sd-icon-btn sd-danger"));
    }
    head.append(headActions);
    card.append(head);

    // Role · files · size (from the server vault list when available).
    const active = (data.vaultList || []).find((v) => v.vaultId === data.vaultId);
    const files = active ? active.fileCount : (data.vaultStats.syncableFiles || 0);
    const sizeBytes = active ? active.sizeBytes : (data.vaultStats.syncableBytes || 0);
    card.append(createElement(
      "div",
      "sd-vc-meta",
      `${data.role || "Worker"} · ${files} file${files === 1 ? "" : "s"} · ${formatBytes(sizeBytes || 0)}`
    ));

    card.append(this.renderStorage());
    card.append(this.renderSyncRow());

    // Actions — primary adapts to whether sync is on.
    const actions = createElement("div", "sd-vc-actions");
    if (data.syncEnabled) {
      actions.append(textButton("refresh-cw", "Sync now", () => this.plugin.finishScan(), "sd-primary-btn sd-grow"));
      actions.append(textButton("cloud-download", "Pull", () => this.plugin.pullLatest()));
      actions.append(textButton("pause", "Pause", () => this.plugin.toggleSync()));
    } else {
      actions.append(textButton("play", "Resume sync", () => this.plugin.toggleSync(), "sd-primary-btn sd-grow"));
      actions.append(textButton("cloud-download", "Pull", () => this.plugin.pullLatest()));
    }
    card.append(actions);

    if (!isPro && data.billingEnabled) {
      card.append(textButton("sparkles", "Upgrade to Pro", () => this.plugin.openUpgradeModal(), "sd-upgrade-btn sd-block-btn"));
    }
    return card;
  }

  renderStorage() {
    const data = this.plugin.data;
    const used = Math.max(0, Number(data.storageUsedMb) || 0);
    const limit = Number(data.storageLimitMb) > 0 ? Number(data.storageLimitMb) : 250;
    const fileMb = Number(data.fileLimitMb) > 0 ? Number(data.fileLimitMb) : 10;
    const ratio = limit > 0 ? Math.min(1, used / limit) : 0;

    const wrap = createElement("div", "sd-storage");
    const head = createElement("div", "sd-storage-head");
    head.append(createElement("span", "", "Storage"));
    head.append(createElement("span", "sd-storage-num", `${used} of ${limit} MB`));
    wrap.append(head);

    const bar = createElement("div", "sd-bar");
    const fill = createElement("div", "sd-bar-fill");
    fill.style.width = `${Math.round(ratio * 100)}%`;
    if (ratio >= 0.9) fill.classList.add("is-full");
    else if (ratio >= 0.75) fill.classList.add("is-warn");
    bar.append(fill);
    wrap.append(bar);

    if (data.storageBlocked) {
      wrap.append(createElement(
        "div",
        "sd-storage-warn",
        data.storageBlockedReason === "server_full"
          ? "The server is temporarily full. Your changes are safe locally and upload later."
          : "Storage full. Free up space or upgrade to Pro to keep syncing."
      ));
    } else {
      wrap.append(createElement("div", "sd-storage-sub", `${fileMb} MB per file on ${data.plan === "pro" ? "Pro" : "Free"}`));
    }
    return wrap;
  }

  renderSyncRow() {
    const state = this.syncState();
    const row = createElement("div", `sd-sync-row is-${state.tone}`);
    row.append(createElement("span", "sd-sync-dot"));
    row.append(createElement("strong", "", state.label));
    if (this.plugin.data.lastSync && state.tone !== "accent") {
      row.append(createElement("span", "sd-sync-time", `· last sync ${this.plugin.data.lastSync}`));
    }
    return row;
  }

  // ---- Vaults (switch / create / inspect) ----------------------------------
  renderVaultsSection() {
    const data = this.plugin.data;
    const open = !!data.vaultInitialized; // is a vault currently open at the top?
    // When no vault is open, list ALL vaults (there's no active one to exclude).
    const others = (Array.isArray(data.vaultList) ? data.vaultList : []).filter((v) => v.vaultId !== data.vaultId);
    const section = this.section("Vaults", others.length || null);

    if (others.length) {
      const list = createElement("div", "sd-rows");
      others.forEach((v) => {
        const row = createElement("div", "sd-row");
        const main = createElement("div", "sd-row-main");
        main.append(createElement("strong", "", v.workspace || "Vault"));
        const files = v.fileCount || 0;
        main.append(createElement("span", "sd-row-sub", `${v.role || "Worker"} · ${files ? `${files} file${files === 1 ? "" : "s"} · ${formatBytes(v.sizeBytes || 0)}` : "empty"}`));
        row.append(main);
        const side = createElement("div", "sd-row-side");
        side.append(textButton("eye", "", () => this.plugin.inspectVault(v), "sd-icon-btn"));
        if (v.owner === data.user.email) {
          // Owner can delete; a member can leave (keeps their local files).
          side.append(textButton("trash-2", "", () => this.plugin.deleteVault(v), "sd-icon-btn sd-danger"));
        } else {
          side.append(textButton("log-out", "", () => this.plugin.leaveVault(v), "sd-icon-btn sd-danger"));
        }
        side.append(textButton("arrow-right-left", open ? "Switch" : "Open", () => this.plugin.switchToVault(v)));
        row.append(side);
        list.append(row);
      });
      section.append(list);
    } else if (open) {
      section.append(this.emptyState("No other vaults", "Create a new vault or invite people to this one."));
    }

    // The create CTA lives in the no-vault card when nothing's open, so don't
    // duplicate it here in that state.
    if (open) {
      const actions = createElement("div", "sd-actions-row");
      actions.append(textButton("plus", "New vault", () => this.plugin.createNewVault(), "sd-grow"));
      section.append(actions);
    }
    section.append(createElement("p", "sd-hint", open
      ? "Switching opens another vault here — the current vault's synced files move to trash (recoverable) so vaults never mix. Tap the eye to peek inside any vault."
      : "Open a vault to sync it into this Obsidian vault. Tap the eye to peek inside any vault first."));
    return section;
  }

  // ---- People ---------------------------------------------------------------
  renderPeople() {
    const data = this.plugin.data;
    const members = Array.isArray(data.members) ? data.members : [];
    const isAdmin = (data.role || "") === "Admin";
    const section = this.section("People", members.length || null);

    if (!members.length) {
      section.append(this.emptyState("No one here yet", "Invite a teammate with a code, or join a vault someone shared with you."));
    } else {
      const list = createElement("div", "sd-rows");
      members.forEach((member) => {
        const row = createElement("div", "sd-row sd-member");
        const main = createElement("div", "sd-row-main sd-member-main");
        main.append(this.avatar(member, "sd-member-avatar"));
        const info = createElement("div", "sd-member-info");
        const isYou = member.email === data.user.email;
        info.append(createElement("strong", "", (member.name || member.email) + (isYou ? " (you)" : "")));
        info.append(createElement("span", "sd-row-sub", member.email));
        main.append(info);
        row.append(main);

        const side = createElement("div", "sd-member-side");
        const role = member.role === "Admin" ? "Admin" : "Worker";
        side.append(createElement("span", `sd-role-badge is-${role.toLowerCase()}`, role));
        const isOwner = data.vaultOwner && member.email === data.vaultOwner;
        if (isAdmin && !isOwner && !isYou) {
          side.append(textButton("user-minus", "", () => this.confirmRemoveMember(member), "sd-icon-btn sd-danger"));
        }
        row.append(side);
        list.append(row);
      });
      section.append(list);
    }

    const actions = createElement("div", "sd-actions-row");
    actions.append(textButton("user-plus", "Invite people", () => this.plugin.createInvite(), "sd-grow"));
    actions.append(textButton("key-round", "Join a vault", () => this.plugin.joinInvite(), "sd-grow"));
    section.append(actions);
    return section;
  }

  // ---- Activity -------------------------------------------------------------
  renderActivity() {
    const queue = this.plugin.data.syncQueue || [];
    const section = this.section("Recent activity", null);
    if (!queue.length) {
      section.append(this.emptyState("Nothing yet", "Edits and syncs show up here while sync is on."));
      return section;
    }
    const list = createElement("div", "sd-activity");
    queue.slice(0, 5).forEach((item) => {
      const row = createElement("div", "sd-activity-row");
      const dot = createElement("span", `sd-act-dot is-${item.status === "done" ? "done" : "pending"}`);
      row.append(dot);
      row.append(createElement("span", "sd-act-label", `${this.actionLabel(item.action)} ${item.path}`.trim()));
      row.append(createElement("span", "sd-act-time", item.time || ""));
      list.append(row);
    });
    section.append(list);
    return section;
  }

  actionLabel(action) {
    const map = { upload: "Uploaded", pull: "Pulled", scan: "Scanned", skip: "Skipped", delete: "Deleted", retry: "Retrying" };
    return map[action] || action || "";
  }

  confirmRemoveMember(member) {
    const name = member.name || member.email;
    const confirmed = window.confirm(`Remove ${name} from this vault?\n\nThey lose sync access and the vault disappears from their Sync Deck. They can rejoin only with a new invite.`);
    if (confirmed) this.plugin.removeVaultMember(member.email);
  }

  // ---- Small building blocks ------------------------------------------------
  section(title, count) {
    const section = createElement("section", "sd-section");
    const header = createElement("div", "sd-section-title");
    header.append(createElement("span", "", title));
    if (count) header.append(createElement("span", "sd-section-count", String(count)));
    section.append(header);
    return section;
  }

  emptyState(title, sub) {
    const empty = createElement("div", "sd-empty");
    empty.append(createElement("strong", "", title), createElement("span", "", sub));
    return empty;
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
}

module.exports = { SyncDeckView };
