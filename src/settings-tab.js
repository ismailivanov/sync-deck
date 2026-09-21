const { PluginSettingTab, Setting } = require("obsidian");

class SyncDeckSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sd-settings");

    containerEl.createEl("p", {
      text: "Realtime vault sync, team roles, and Task Deck collaboration.",
    });

    new Setting(containerEl)
      .setName("Dashboard")
      .setDesc("Open the Sync Deck control panel.")
      .addButton((button) => {
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => this.plugin.activateView());
      });

    new Setting(containerEl)
      .setName("Account")
      .setDesc(this.plugin.data.signedIn ? this.plugin.data.user.email : "Not signed in.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.data.signedIn ? "Sign out" : "Sign in")
          .onClick(() => this.plugin.data.signedIn ? this.plugin.signOut() : this.plugin.signIn());
      });

    const data = this.plugin.data;
    // Shown even when the server has the feature off, as long as a sealed copy
    // may still exist for this account — otherwise there is no way to remove it.
    if (data.signedIn && (data.escrowAvailable !== false || data.escrowRemote || this.plugin.escrowIsConfirmed())) {
      new Setting(containerEl)
        .setName("Vault password")
        .setDesc(this.plugin.escrowIsConfirmed()
          ? "On. Signing in on a new device unlocks your encrypted vaults. The server never sees the password."
          : data.escrowRemote
          ? "On for this account, but not yet used on this device."
          : "Off. A new device needs the SDK1 recovery key to unlock an encrypted vault.")
        .addButton((button) => {
          // Change works without local proof — it asks for the current password —
          // so an account that has one is never stuck on "Set up".
          const joined = this.plugin.escrowIsConfirmed() || data.escrowRemote;
          button
            .setButtonText(joined ? "Change" : "Set up")
            .onClick(async () => {
              if (joined) await this.plugin.changeVaultPassword();
              else await this.plugin.setUpVaultPassword();
              this.display();
            });
        })
        .addButton((button) => {
          // The panel is not the only way out: a failed removal must be
          // retryable from here too.
          const joined = this.plugin.escrowIsConfirmed() || data.escrowRemote;
          button
            .setButtonText("Turn off")
            .setDisabled(!joined)
            .onClick(async () => {
              await this.plugin.disableVaultPassword();
              this.display();
            });
        });
    }

    new Setting(containerEl)
      .setName("API server")
      .setDesc("Cloud API server for auth and vault registration.")
      .addText((text) => {
        text
          .setPlaceholder("https://api.syncdeck.cloud")
          .setValue(this.plugin.data.serverUrl)
          .onChange(async (value) => {
            this.plugin.data.serverUrl = value.trim() || "https://api.syncdeck.cloud";
            await this.plugin.savePluginData();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Ping")
          .onClick(async () => {
            try {
              await this.plugin.pingServer();
            } catch (error) {
              this.plugin.data.serverStatus = "offline";
              await this.plugin.savePluginData();
            }
          });
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "0.1.0");
  }
}

module.exports = { SyncDeckSettingTab };
