# Oh My Git 0.0.1

仅桌面端，Obsidian >= 1.8.7。UI 跟随 Obsidian 中文/英文设置。

## 配置与目录

可调参数集中在插件目录的 `config.jsonc`，启动时读取一次；修改后禁用再启用插件。文件缺失时使用构建时打包的默认值；无法解析时显示 ×。
格式为 JSONC：允许 `//`、`/* */` 注释和尾随逗号，每个参数的说明直接写在文件注释里。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| syncIntervalSeconds | 300 | 定时同步间隔，秒 |
| saveDebounceSeconds | 30 | 最后一次保存后静默多少秒才触发 onSave |
| gitTimeoutSeconds | 120 | 单条 Git 命令超时，秒 |
| maxFileMiB | 30 | 插件提交的单文件上限，MiB |
| successDisplayMs | 1000 | 成功 √ 的显示时长，毫秒 |
| escalateAfterFailures | 5 | 非阻塞失败连续达到此次数后显示 ×（仍不暂停同步） |
| placeboMode | "hidden" | Ctrl/Cmd+S 安慰剂的挂载方式：`default` 或 `hidden`，见「事件」 |
| monthlyBackupEnabled | true | 是否创建月度备份分支 |
| lfsExtensions | 见配置文件 | LFS 扩展名，不含点，大小写不敏感 |

省略的字段使用默认值。配置值不做校验，写错由用户自行修正。

```text
src/
  main.ts       # Obsidian 事件、状态栏和交互
  i18n.ts       # 中英文文案字典
  sync.ts       # 快照、保护、合并、推送和月度备份
  git.ts        # Git 执行及错误分类
  config.ts     # JSONC 解析、默认值和配置读取
  jsonc.d.ts    # 让 tsc 识别 .jsonc 文本导入
tests/
  ui.cjs        # 状态、交互和重试
  sync.cjs      # 临时仓库中的同步与数据保护
  config.cjs    # 配置及 Git 错误信息
  setup.cjs     # setup-git.cmd 的 sh 部分
scripts/
  read-record.cjs  # 只读解析提交元数据
  setup-git.cmd    # 手动执行的 Vault Git 配置脚本（cmd/sh 双语）
config.jsonc       # 带注释的默认配置，同时打包进 main.js
dist/              # 构建产物，即分发内容（不入库）
  manifest.json
  main.js
  config.jsonc
  scripts/read-record.cjs
  scripts/setup-git.cmd
```

## 安装

从社区插件市场安装：只会下载 `main.js` 和 `manifest.json`。需要改配置时，从本仓库复制 `config.jsonc` 到 `<Vault>/.obsidian/plugins/oh-my-git/` 再修改；需要审计工具时同样复制 `scripts/read-record.cjs`。

手动安装：执行 `npm run build`，然后把 `dist/` 里的全部内容复制到 `<Vault>/.obsidian/plugins/oh-my-git/`，最后在 Obsidian 里启用插件。
其中只有 `manifest.json` 和 `main.js` 是必需的。`config.jsonc` 不放时使用内置默认值；`scripts/read-record.cjs` 是可选的审计工具，`scripts/setup-git.cmd` 是可选的 Git 配置脚本。
源码仓库应放在 Vault 之外，否则源码会被插件同步进笔记仓库。

## 发版

1. 同步修改 `manifest.json`、`package.json` 的 `version`，并在 `versions.json` 中追加 `"<版本>": "<minAppVersion>"`。
2. `npm test`，提交后推送到 GitHub 默认分支。
3. 创建 GitHub Release，tag 与 `version` 完全一致（不带 `v`），附件上传 `dist/main.js` 和 `dist/manifest.json`。

## 许可证

[AGPL-3.0-or-later](LICENSE)

## 前提

- 系统 PATH 中有 Git 和 git lfs，Obsidian 进程能找到它们。macOS 从 Dock 启动的应用不继承 shell PATH，插件会自动追加 `/opt/homebrew/bin` 和 `/usr/local/bin`；装在其他位置的需自行处理。缺少 Git 或 git lfs 时显示 × 和安装提示（macOS 给出 brew 命令），插件不会代为安装。
- Vault 是 Git 仓库，当前分支配置了远程 upstream，且不以 `ogit/` 开头。
- 配置好 user.name、user.email；认证和签名必须能在非交互环境下完成。

建议在 Vault 的 .gitignore 中忽略 `.obsidian/workspace*.json`：Obsidian 会不停地改写这些文件，多台设备同步时几乎每次都会冲突。`scripts/setup-git.cmd` 可以一次配好。

## Git 配置脚本 setup-git.cmd

手动执行，不会被插件自动调用。Windows 双击或在 cmd 中运行；macOS/Linux 执行 `sh setup-git.cmd`。运行前关闭 Obsidian 或禁用插件。

1. 从脚本所在目录向上找第一个名为 `.obsidian` 的目录，其父目录即 Vault。
2. Vault 下没有 `.git` 时执行 `git init -b main` 和 `git lfs install --local`。
3. `.gitattributes` 没有 `# BEGIN OGIT LFS` 区块时追加（与插件默认 lfsExtensions 一致，之后由插件按配置维护）；`.gitignore` 没有 `# BEGIN OGIT IGNORE` 区块时追加。已有区块跳过，用户自己的规则不动。
4. 已有仓库：按全部 ignore 规则取消跟踪已被忽略的文件，磁盘文件保留。推送后，其他设备下次合并时会删除它们本地的这些文件，历史中仍可找回。
5. 提交：新仓库提交整个 Vault（`ogit: initialize vault (setup-git)`），已有仓库只提交规则变更（`ogit: apply ignore and LFS rules (setup-git)`）。不推送，也不处理 remote，remote 由用户维护。

重复执行是安全的。缺少 Git、git lfs（仅初始化时需要）或 user.name/user.email 时给出提示后退出，不会代为安装。
脚本必须保持 LF 换行（仓库 `.gitattributes` 已约束）；规则数据只写一份，在文件末尾的 `#I`/`#A` 行。

插件不会安装 Git、初始化仓库、设置 upstream，也不会强推工作分支。Vault 的 .gitignore 由用户维护，被忽略的文件不在备份范围内。其他不满足条件的情况由 Git 自身报错，错误信息打印在控制台。

## 事件

- onLoad / onRetry / onResolve / onCron：提交本地变化 → fetch upstream → 落后则快进，分叉则保护双方并在临时 worktree 中整合 → 应用到 Vault → push → 月度备份。
- onOpen / onSave / onClose / onRename / onClick：提交整个仓库 → push → 月度备份，不主动拉取。push 被拒且远程已前进时，按上面的方式整合后重推一次。
- 没有新提交（本地与 upstream 相同）时不 push。
- onSave 带防抖：每次文件修改都把计时器重置为 saveDebounceSeconds，静默期满才同步一次。连续编辑期间由 onCron 兜底。其他事件开始同步时会取消计时器，因为这次同步已包含这些修改。
- onRename：Obsidian 中重命名文件或文件夹后立即同步，不走防抖。这样改名会单独形成一个提交（相似度 100%），不会和后续编辑混在一起，用 `git log --follow -- <新路径>` 可以追溯到改名前的历史。Git 本身不记录重命名，`git mv` 与 `add -A` 的结果相同，所以插件不使用 `git mv`。
- 「重试」统一按 onLoad 模式完整执行一次。
- Ctrl/Cmd+S 是安慰剂：只在待机时让图标转一下再显示 √，不执行任何 Git 操作，也不拦截 Obsidian 自己的保存。黄色 ! 和红色 × 状态下不响应，以免掩盖故障。真实同步开始时会立即接管状态栏。挂载方式由 placeboMode 决定：
  - `hidden`（默认）：包装 Obsidian 内部命令 `editor:save-file`，先执行原来的保存逻辑，再显示安慰剂。能覆盖快捷键、命令面板，以及用户自定义的保存快捷键。这是**未公开 API**，Obsidian 升级后可能失效；找不到该命令时只记一条日志，安慰剂不生效。插件卸载时恢复原回调。
  - `default`：在 `window` 的捕获阶段监听 Ctrl/Cmd+S（同时识别物理键位 KeyS，兼容输入法），弹出窗口打开时也会注册。只用公开 API，但只覆盖键盘快捷键。Obsidian 的快捷键系统会在 `window` 捕获阶段对保存调用 `stopPropagation`，所以不能监听 `document`。
  - 排查时，在 Console 中过滤 `Oh My Git`，查看 `Placebo hooked save command`、`Save command executed`、`Save shortcut detected`、`Placebo skipped` 这几条日志。
- onUnload：请求取消，当前 Git 命令执行完后不再启动后续步骤。

同步进行中（包括显示成功 √ 期间）新触发的事件直接丢弃。

| 状态 | 行为 |
| --- | --- |
| 同步图标 | 待机，接收事件 |
| 旋转图标 | 同步中 |
| 绿色 √ | 成功 |
| 黄色 ! | 普通失败或跳过了超限文件，后续事件照常同步 |
| 红色 × | 需要关注；点击打开菜单「重试」 |

失败分两类：

- **阻塞**（立即 ×，暂停普通事件，直到重试成功）：config.jsonc 无法读取（`config`）、仓库状态不满足，例如没有 upstream 或分离 HEAD（`repo`）、远程拒绝推送，例如 hook、受保护分支或权限（`refused`）、历史冲突（`conflict`）。历史冲突时菜单额外提供「保持远程 / 保持本地」。
- **不阻塞**：仓库有未完成的手动 Git 操作（`unfinished`，见下）、无法连接远程或认证失败（`remote`），以及其余失败（`failed`）。先显示 !；**连续 escalateAfterFailures 次**（默认 5）失败后显示 ×，但普通事件仍照常执行，本地快照不会中断。任意一次成功即清零。

`unfinished`：你在终端执行 merge、cherry-pick、revert 或 rebase 且尚未完成时（存在 `MERGE_HEAD` 等标记，或索引里有未合并的文件），插件在修改仓库**之前**就停下，不会把冲突标记当作已解决提交和推送。你完成（`git commit`）或取消（`--abort`）之后，下一次事件会自动恢复同步，不需要点重试。

错误分类只看 Git 的退出码和结构化输出，不匹配报错文字：push 的 `--porcelain` 输出中有 `!` 开头的行，表示引用被拒绝（再根据远程是否分叉区分 `conflict` 和 `refused`）；没有这类行，说明没能与远程完成通信（`remote`）。网络故障和认证失败无法区分，统一按 `remote` 计数。
失败时 Git 的原始输出会打印到控制台（Ctrl+Shift+I → Console，`[Oh My Git]` 前缀），其中可能包含 remote URL。

## 数据保护

- 分叉整合前，本地和远程各推送一个不可变恢复分支，推送失败就停止；整合结果另存一个本地 result 分支。快进不创建恢复分支：双方提交都已在 upstream 上。
- 合并在临时 worktree 中进行，冲突不写入 Vault。
- 用两树 `read-tree -m -u` 应用结果：Git 会拒绝覆盖未提交的修改和未跟踪文件，但**被 .gitignore 忽略的文件可能被覆盖**。Vault 内不使用 reset --hard 或 clean。
- 日常 push 被拒绝时会 fetch：远程未前进视为服务端拒绝（×）；前进了则快进或保护双方后整合并重推，只有内容冲突才进入 ×。
- 重推时远程又前进（多台设备抢推送）按网络错误处理，下次同步再整合，不进入 ×。
- onCron 和 push 被拒的日常事件也会把远程改动写入 Vault。若从快照到写入的几秒内，用户正好编辑了远程也改过的文件，read-tree 会拒绝覆盖并报错，数据不受影响，下次同步重新整合（每次整合都会新建一组恢复分支）。
- 远程不可用时，本地快照照常提交；恢复连接后的下一次同步会一并推送。
- 保持本地/远程：选择整个 Git 跟踪文件树，以 upstream 为第一父提交；upstream 尚未包含本地历史时，以本地快照为第二父提交。不使用 rebase，不强推。

## 空日记

Obsidian 启动时会自动创建当天的空日记。如果另一台设备已经推送了同名日记，空文件会导致 add/add 冲突，或者挡住合并结果的写入。插件按以下规则处理"空 md"，即**未跟踪**、0 字节的 `.md` 文件（扩展名不区分大小写，不含符号链接）：

| 范围 | 时机 | 条件 | 动作 |
| --- | --- | --- | --- |
| 全 Vault | 每次快照 | — | 不 add，文件留在磁盘 |
| 日记目录 | 仅 onLoad，快照前 | 创建日期不是今天，且已创建超过 2 小时 | 删除 |
| 全 Vault | 整合时，应用结果前 | 合并结果里有同名文件，且删除前复查仍为 0 字节 | 删除（0 字节，无损） |

- 日记目录取自核心插件「日记」的配置 `<configDir>/daily-notes.json` 中的 `folder`（含子目录），启动时读取一次。文件不存在、无法解析或 `folder` 为空（日记放在 Vault 根目录）时，不做 onLoad 清理；撞名删除不依赖日记目录。
- 创建时间：Windows/macOS 用 birthtime，其他平台或 birthtime 无效时用 mtime。"今天"按本机时区的自然日。
- 已跟踪文件、非 `.md` 文件不受影响：清空一篇已跟踪的笔记照常提交。
- 不在状态栏提示。跳过和删除的路径记在 history.jsonl 的 `emptySkipped`、`emptiesRemoved` 字段；`emptySkipped` 只在列表与上次不同时记录。

## 分支命名

- `ogit/recovery/<原因>/<UTC时间>-<设备ID>-<随机ID>/local|remote|result`
- 原因：merge、push-rejected、keep-local、keep-remote
- `ogit/monthly/YYYY-MM/<安全分支名>-<分支名 SHA256 前8位>`

每月首次成功推送后创建当月的备份分支（月份按本地时区），已存在的不会覆盖（create-only lease）。失败只记日志，下次同步再试，不影响主线同步结果。恢复分支不会自动删除。

## 提交大小与 LFS

- 快照提交前，会检查本次新增或修改的文件在工作区的实际大小（LFS 文件同样按实际大小计算）。超过 maxFileMiB 的文件会被取消暂存、**不入库**，其余内容照常提交和推送，然后显示 ! 并列出被跳过的文件。工作区文件不受影响。之后每次同步都会继续跳过并提醒，直到你把它加入 .gitignore 或删除。
- 已经在历史中的大文件（例如从远程合并进来，或者在终端手动提交的）不受限制，启动合并照常进行；只有在本地被修改时，新内容才受限。
- 插件维护 .gitattributes 中的 OGIT LFS 区块，不改动区块外的用户规则。
- LFS 对象由 `git lfs install --local` 安装的 pre-push hook 上传；不会覆盖用户自定义的 pre-push hook，有冲突时 Git LFS 报错，需要自行整合。
- 已有历史不重写、不迁移。

## 提交元数据（schemaVersion 2）

提交标题固定为英文，正文中用 Ogit-Metadata-Begin / Ogit-Metadata-End 包围一段 JSON：operationId、event、action、device、time、branch、upstream、resultTree、parents；整合提交还包含 localCommit、remoteCommit、两个恢复分支名，选边提交另有 strategy、reason。

只读解析：在插件目录执行 `node scripts/read-record.cjs <提交ID> [Vault路径]`。
查看已推送的快照：`git show <恢复分支>:<文件路径>`。LFS 文件显示的是指针，恢复二进制需要在独立 worktree 中执行 lfs pull。

## 操作记录

本机记录位于 Vault 之外的 `%LOCALAPPDATA%/ObsidianOhMyGit/<仓库ID>/`（非 Windows 为 `~/.local/state/...`）：

```text
device.txt           # 保留：本机设备 ID
state.json           # 保留：月度备份进度
history.jsonl        # 保留：每次操作的记录（阶段、提交、恢复分支、错误码和 Git 输出）
.omg.pending.json    # 临时：进行中操作的记录
.omg.worktree-<id>/  # 临时：合并用的 worktree
```

以 `.omg.` 开头的都是临时产物。正常结束的操作会把记录追加到 history.jsonl，并删除 pending。
Obsidian 被强制退出时可能留下残留。插件**启动时**会自动清理：把残留的 pending 以 `outcome: "interrupted"` 归档到 history.jsonl，删除所有 `.omg.*`，执行 `git worktree prune`。
插件**从不删除** `index.lock`：残留 pending 只能说明上次同步中断了，不能说明锁是谁的（可能是你之后启动的 Git，比如正在编辑提交信息的 `git commit`）。如果有残留 pending，同时 `index.lock` 存在，会显示阻塞的 ×（`repo`），提示锁文件路径；请确认没有 Git 进程在运行后手动删除，再点重试。
如果在把合并结果应用到 Vault 的途中被打断，下次快照会把已经应用的部分当作本地修改提交，再与远程合并（通常能干净合并）。合并前双方的原始提交都在恢复分支里，不会丢。
插件重新加载时，如果旧实例的同步仍在执行，新实例的这次同步会失败一次（!），等旧实例结束后恢复正常。

## 开发与验证

```text
npm install
npm run build
npm test
```

测试会创建独立的临时本地仓库和 bare 远程仓库，不访问网络；临时目录会打印并保留，供审计。
`npm run build` 会清空并重建 `dist/`；`npm test` 会先执行构建，UI 测试直接加载 `dist/main.js`。
修改 src/ 后，重新构建并把 `dist/` 复制到 Vault 的插件目录，再禁用并启用插件。只修改插件目录里的 config.jsonc 时，重新启用插件即可。
