# File Explorer Split

为 Obsidian 的左侧原生“文件列表”增加分栏按钮。点击后创建另一个原生文件列表，因此继续使用现有主题、右键菜单、排序、搜索和拖拽移动逻辑。

## 使用方式

- 左侧栏顶部、文件列表/书签/搜索标签右侧的面板图标：按默认方向分栏。
- 设置 → **File Explorer Split**：选择默认的左右或上下分栏。
- 命令面板：`File Explorer Split: Split current file explorer`。
- 拖动任一原生文件列表顶部的文件夹图标到另一个文件夹图标：交换两个文件列表的位置。
- 命令面板：`File Explorer Split: Swap file explorer positions`。
- 普通拖动：沿用原生移动。
- 按住 `Ctrl` 拖动到另一文件夹：复制；同名文件夹会合并，同名文件会出现整批处理对话框。

最多同时显示 4 个左侧原生文件列表。插件使用目录链接装入 Life-OS，修改代码后执行 `npm run build`，再在 Obsidian 中执行“重新加载应用（不保存）”或重启即可加载新版本。
