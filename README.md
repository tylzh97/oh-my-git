# Oh My Git

[![nightly](https://github.com/tylzh97/oh-my-git/actions/workflows/nightly.yml/badge.svg)](https://github.com/tylzh97/oh-my-git/actions/workflows/nightly.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A5%201.8.7-7c3aed.svg)](https://obsidian.md)

把 Obsidian Vault 当作 Git 仓库自动同步的桌面端插件。每次操作都先提交快照，不强推、不改写历史：出了问题能找回，也查得清发生过什么。

## 特性

- **自动同步**：停止编辑 30 秒后提交并推送，每 5 分钟做一次含拉取的完整同步，按 Ctrl/Cmd+S 也会触发一次完整同步。
- **不丢数据**：先提交本地快照再整合远程；合并在 Vault 之外进行，冲突不会写进笔记；不使用 `reset --hard` 和 `clean`，不强推。
- **可恢复**：两台设备的历史分叉时，整合前先把双方各推一个恢复分支；每月另留一个备份分支。
- **可审计**：插件创建的每个提交都带结构化的元数据，本机保留每次操作的记录。
- **大文件**：常见的二进制格式自动交给 Git LFS；超过大小上限（默认 30 MiB）的文件跳过并提醒，其余内容照常同步。
- **状态可见**：状态栏图标区分待机、同步中、成功、警告和需要处理，界面跟随 Obsidian 的中文或英文设置。

## 工作原理

一次完整同步按固定顺序执行，任何一步失败就停下，已经提交的内容不受影响：

1. **快照**：把 Vault 的全部改动提交到本地。
2. **拉取**：获取远程分支的最新提交。
3. **整合**：远程领先就快进；双方都有新提交就在 Vault 之外合并，合并成功才写回 Vault。
4. **推送**：把结果推到远程。

## 前提

- 桌面端 Obsidian 1.8.7 或更高版本，不支持移动端。
- 系统里装有 Git 和 Git LFS，并且 Obsidian 进程能找到它们。
- Vault 是一个 Git 仓库，当前分支已经设置远程 upstream。
- 已配置 `user.name` 和 `user.email`；远程认证和提交签名都不需要交互输入。

插件不会替你安装 Git、初始化仓库或设置远程。macOS 的 PATH 问题和其他细节见 [环境准备与安装](docs/setup.md)。

## 安装

插件尚未上架 Obsidian 社区插件市场，目前从 Release 安装：

1. 从 [Releases](https://github.com/tylzh97/oh-my-git/releases) 下载 `main.js` 和 `manifest.json`。想用最新代码可以选 [nightly](https://github.com/tylzh97/oh-my-git/releases/tag/nightly)，它随 `main` 的每次提交自动重建。
2. 把这两个文件放进 `<Vault>/.obsidian/plugins/oh-my-git/`。
3. 在 Obsidian 的「第三方插件」里启用 Oh My Git。

Release 里的其余文件都是可选的：`config.jsonc` 用来修改配置，`setup-git.cmd` 用来初始化 Vault 仓库，`prune-recovery.cjs` 用来清理旧的恢复分支。两个脚本要放进插件目录下的 `scripts/` 子目录。

也可以从源码构建，产物在 `dist/`，把里面的内容复制到上面的插件目录即可：

```bash
git clone https://github.com/tylzh97/oh-my-git.git
cd oh-my-git
npm install
npm run build
```

## 快速开始

Vault 已经是配置好远程的 Git 仓库时，安装并启用插件就可以了。否则按下面的步骤准备：

1. 按「安装」放好文件，先不要启用插件。
2. 运行 `scripts/setup-git.cmd`：Windows 双击，macOS 和 Linux 执行 `sh setup-git.cmd`。它会初始化仓库，写入忽略规则和 LFS 规则，并提交一次。
3. 添加远程并推送，脚本不处理这一步：

   ```bash
   git remote add origin <你的仓库地址>
   git push -u origin main
   ```

4. 启用插件。状态栏出现同步图标，启动时会先做一次完整同步，之后正常写笔记即可。

## 使用

### 什么时候同步

| 触发 | 做什么 |
| --- | --- |
| 启动插件 | 完整同步：提交本地改动，拉取并整合远程，推送 |
| 每 5 分钟 | 完整同步 |
| 按 Ctrl/Cmd+S | 完整同步 |
| 停止编辑 30 秒后 | 提交并推送，不主动拉取 |
| 重命名文件或文件夹 | 提交并推送，不主动拉取 |
| 点击状态栏图标 | 提交并推送，不主动拉取 |

### 状态栏图标

| 图标 | 含义 |
| --- | --- |
| 同步图标 | 待机 |
| 旋转的图标 | 同步中 |
| 绿色 √ | 刚同步成功 |
| 黄色 ! | 上次同步失败，或有文件超过大小上限被跳过；后续照常同步 |
| 红色 × | 需要你处理，同步已暂停 |

把鼠标停在图标上可以看到具体原因。

### 出现红色 × 时

点击图标，在菜单里选「重试」。配置文件无法读取时没有菜单，修正后需要禁用再启用插件。

如果原因是历史冲突，比如两台设备改了同一处内容，菜单里还会有「保持远程」和「保持本地」。这两项选的是**整个仓库**的版本：另一侧的改动不会留在 Vault 里，包括那些并不冲突的文件。它们仍然保存在 Git 历史和恢复分支中，需要时用 Git 取回，见 [数据保护](docs/data-protection.md)。

## 配置

默认配置可以直接使用。需要调整时，把 `config.jsonc` 放进插件目录后修改，再禁用并启用插件。可以调整同步间隔、自动保存的等待时长、单文件大小上限、LFS 扩展名等，每个参数的说明都写在 [`config.jsonc`](config.jsonc) 的注释里。

## 注意事项

- 只备份 Git 跟踪的内容：被 `.gitignore` 忽略的文件不在备份范围内。
- Vault 里嵌套的 Git 仓库只会被记录成一个引用，里面的文件不会被备份。
- 多台设备同步时，建议忽略 `.obsidian/workspace*.json`，否则几乎每次都会冲突。`setup-git.cmd` 写入的忽略规则已经包含它。

## 文档

| 文档 | 内容 |
| --- | --- |
| [环境准备与安装](docs/setup.md) | 前提条件、`setup-git.cmd` 做了什么、安装布局和配置文件 |
| [同步机制](docs/sync.md) | 每个事件做什么、防抖与排队、状态和失败分类 |
| [数据保护](docs/data-protection.md) | 整合与应用、恢复分支、月度备份、空日记、大文件与 LFS |
| [审计与排查](docs/audit.md) | 提交元数据、本机操作记录、中断后的清理 |
| [开发与发版](docs/development.md) | 目录结构、构建与测试、nightly 和正式版的发布流程 |

## 开发

```bash
npm install
npm test
```

`npm test` 会先构建，再在临时仓库里跑全部测试，不访问网络。详见 [开发与发版](docs/development.md)。

## 反馈

问题和建议请提 [Issue](https://github.com/tylzh97/oh-my-git/issues)。

## 许可证

[AGPL-3.0-or-later](LICENSE)
