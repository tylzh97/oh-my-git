# 环境准备与安装

[← 返回 README](../README.md)

## 前提

- 系统 PATH 中有 Git 和 git lfs，Obsidian 进程能找到它们。macOS 从 Dock 启动的应用不继承 shell PATH，插件会自动追加 `/opt/homebrew/bin` 和 `/usr/local/bin`；装在其他位置的需自行处理。缺少 Git 或 git lfs 时显示 × 和安装提示（macOS 给出 brew 命令），插件不会代为安装。
- Vault 是 Git 仓库，当前分支配置了远程 upstream，且不以 `ogit/` 开头。
- 配置好 user.name、user.email；认证和签名必须能在非交互环境下完成。

建议在 Vault 的 .gitignore 中忽略 `.obsidian/workspace*.json`：Obsidian 会不停地改写这些文件，多台设备同步时几乎每次都会冲突。`scripts/setup-git.cmd` 可以一次配好。

插件不会安装 Git、初始化仓库、设置 upstream，也不会强推工作分支。Vault 的 .gitignore 由用户维护，被忽略的文件不在备份范围内。其他不满足条件的情况由 Git 自身报错，错误信息打印在控制台。

## Git 配置脚本 setup-git.cmd

手动执行，不会被插件自动调用。Windows 双击或在 cmd 中运行；macOS/Linux 执行 `sh setup-git.cmd`。运行前关闭 Obsidian 或禁用插件。

1. 从脚本所在目录向上找第一个名为 `.obsidian` 的目录，其父目录即 Vault。
2. Vault 下没有 `.git` 时执行 `git init -b main` 和 `git lfs install --local`。
3. `.gitattributes` 没有 `# BEGIN OGIT LFS` 区块时追加（与插件默认 lfsExtensions 一致，之后由插件按配置维护）；`.gitignore` 没有 `# BEGIN OGIT IGNORE` 区块时追加。已有区块跳过，用户自己的规则不动。
4. 已有仓库：按全部 ignore 规则取消跟踪已被忽略的文件，磁盘文件保留。推送后，其他设备下次合并时会删除它们本地的这些文件，历史中仍可找回。
5. 提交：新仓库提交整个 Vault（`ogit: initialize vault (setup-git)`），已有仓库只提交规则变更（`ogit: apply ignore and LFS rules (setup-git)`）。不推送，也不处理 remote，remote 由用户维护。

重复执行是安全的。缺少 Git、git lfs（仅初始化时需要）或 user.name/user.email 时给出提示后退出，不会代为安装。
脚本必须保持 LF 换行（仓库 `.gitattributes` 已约束）；规则数据只写一份，在文件末尾的 `#I`/`#A` 行。

## 安装

插件目录是 `<Vault>/.obsidian/plugins/oh-my-git/`，完整的布局与 `dist/` 一致：

```text
main.js                    # 必需
manifest.json              # 必需
config.jsonc               # 可选：不放时使用内置默认值
scripts/setup-git.cmd      # 可选：Git 配置脚本
scripts/prune-recovery.cjs # 可选：恢复分支清理工具
```

- **从 Release 安装**：在 [Releases](https://github.com/tylzh97/oh-my-git/releases) 下载需要的文件放进插件目录，然后在 Obsidian 里启用插件。两个脚本要放进 `scripts/` 子目录，文档里的命令都按这个位置写。
- **从源码构建**：执行 `npm run build`，把 `dist/` 里的全部内容复制到插件目录，然后在 Obsidian 里启用插件。

插件尚未上架 Obsidian 社区插件市场。

源码仓库应放在 Vault 之外。Vault 里嵌套的 Git 仓库只会被记录成一个引用，里面的文件不会被提交，也就不会被备份或同步到其他设备。

## 配置文件

可调参数集中在插件目录的 `config.jsonc`，启动时读取一次；修改后禁用再启用插件。文件缺失时使用构建时打包的默认值；无法解析时显示 ×。
格式为 JSONC：允许 `//`、`/* */` 注释和尾随逗号，每个参数的说明直接写在文件注释里。

省略的字段使用默认值。配置值不做校验，写错由用户自行修正。
