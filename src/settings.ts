import { App, PluginSettingTab, Setting } from "obsidian";
import type FileExplorerSplitPlugin from "./main";
import type { SplitDirection } from "./types";

export interface FileExplorerSplitSettings {
  defaultDirection: SplitDirection;
}

export const DEFAULT_SETTINGS: FileExplorerSplitSettings = {
  defaultDirection: "vertical",
};

export class FileExplorerSplitSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: FileExplorerSplitPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("默认分栏方向")
      .setDesc("点击“分栏文件列表”图标时，新文件列表出现的位置。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("vertical", "左右分栏（新栏在右侧）")
          .addOption("horizontal", "上下分栏（新栏在下方）")
          .setValue(this.plugin.settings.defaultDirection)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              defaultDirection: value === "horizontal" ? "horizontal" : "vertical",
            });
          });
      });
  }
}
