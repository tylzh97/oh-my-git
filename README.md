# Custom Git Sync 0.0.1

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
scripts/
  read-record.cjs  # 只读解析提交元数据
config.jsonc       # 带注释的默认配置，同时打包进 main.js
dist/              # 构建产物，即分发内容（不入库）
  manifest.json
  main.js
  config.jsonc
  scripts/read-record.cjs
```

## 安装

执行 `npm run build`，然后把 `dist/` 里的全部内容复制到 `<Vault>/.obsidian/plugins/custom-git-sync/`，最后在 Obsidian 里启用插件。
其中只有 `manifest.json` 和 `main.js` 是必需的。`config.jsonc` 不放时使用内置默认值；`scripts/read-record.cjs` 是可选的审计工具。
源码仓库应放在 Vault 之外，否则源码会被插件同步进笔记仓库。

## 前提

- 系统 PATH 中有 Git 和 git lfs，Obsidian 进程能找到它们。
- Vault 是 Git 仓库，当前分支配置了远程 upstream，且不以 `ogit/` 开头。
- 配置好 user.name、user.email；认证和签名必须能在非交互环境下完成。

插件不会安装 Git、初始化仓库、设置 upstream，也不会强推工作分支。Vault 的 .gitignore 由用户维护，被忽略的文件不在备份范围内。其他不满足条件的情况由 Git 自身报错，错误信息打印在控制台。

## 事件

- onLoad / onRetry / onResolve：提交本地变化 → fetch upstream → 必要时保护双方并在临时 worktree 中整合 → 应用到 Vault → push → 月度备份。
- onOpen / onSave / onClose / onRename / onCron / onClick：提交整个仓库 → push → 月度备份，不拉取、不合并。
- onSave 带防抖：每次文件修改都把计时器重置为 saveDebounceSeconds，静默期满才同步一次。连续编辑期间由 onCron 兜底。其他事件开始同步时会取消计时器，因为这次同步已包含这些修改。
- onRename：Obsidian 中重命名文件或文件夹后立即同步，不走防抖。这样改名会单独形成一个提交（相似度 100%），不会和后续编辑混在一起，用 `git log --follow -- <新路径>` 可以追溯到改名前的历史。Git 本身不记录重命名，`git mv` 与 `add -A` 的结果相同，所以插件不使用 `git mv`。
- 「重试」统一按 onLoad 模式完整执行一次。
- Ctrl/Cmd+S 是安慰剂：只在待机时让图标转一下再显示 √，不执行任何 Git 操作，也不拦截 Obsidian 自己的保存。黄色 ! 和红色 × 状态下不响应，以免掩盖故障。真实同步开始时会立即接管状态栏。
- onUnload：请求取消，当前 Git 命令执行完后不再启动后续步骤。

同步进行中（包括显示成功 √ 期间）新触发的事件直接丢弃。

| 状态 | 行为 |
| --- | --- |
| 同步图标 | 待机，接收事件 |
| 旋转图标 | 同步中 |
| 绿色 √ | 成功 |
| 黄色 ! | 普通失败（网络等），后续事件照常同步 |
| 红色 × | 需要人工处理，暂停普通事件，从菜单重试 |

进入 × 的情况：config.jsonc 无法读取、仓库状态不满足（没有 upstream、分离 HEAD）、远程认证/权限/hook 拒绝、历史冲突、文件超过上限、上次操作未完成。其余失败都显示 !。
历史冲突时，菜单额外提供「保持远程 / 保持本地」。
失败时 Git 的原始输出会打印到控制台（Ctrl+Shift+I → Console，`[Custom Git Sync]` 前缀），其中可能包含 remote URL。

## 数据保护

- 整合前，本地和远程各推送一个不可变恢复分支，推送失败就停止；整合结果另存一个本地 result 分支。
- 合并在临时 worktree 中进行，冲突不写入 Vault。
- 用两树 `read-tree -m -u` 应用结果：Git 会拒绝覆盖未提交的修改和未跟踪文件，但**被 .gitignore 忽略的文件可能被覆盖**。Vault 内不使用 reset --hard 或 clean。
- 日常 push 被拒绝时会 fetch，并在远程已分叉时保护双方，然后进入 ×，不自动整合。
- 保持本地/远程：选择整个 Git 跟踪文件树，以 upstream 为第一父提交；upstream 尚未包含本地历史时，以本地快照为第二父提交。不使用 rebase，不强推。

## 分支命名

- `ogit/recovery/<原因>/<UTC时间>-<设备ID>-<随机ID>/local|remote|result`
- 原因：startup-merge、push-rejected、keep-local、keep-remote
- `ogit/monthly/YYYY-MM/<安全分支名>-<分支名 SHA256 前8位>`

每月首次成功推送后创建当月的备份分支（月份按本地时区），已存在的不会覆盖（create-only lease）。失败只记日志，下次同步再试，不影响主线同步结果。恢复分支不会自动删除。

## 提交大小与 LFS

- 插件发起的每次提交都会检查本次新增/修改文件在工作区的实际大小，超过 maxFileMiB 时显示 × 并列出文件，不提交也不删除任何内容。终端里的手动提交不受此限制。
- 插件维护 .gitattributes 中的 OGIT LFS 区块，不改动区块外的用户规则。
- LFS 对象由 `git lfs install --local` 安装的 pre-push hook 上传；不会覆盖用户自定义的 pre-push hook，有冲突时 Git LFS 报错，需要自行整合。
- 已有历史不重写、不迁移。

## 提交元数据（schemaVersion 2）

提交标题固定为英文，正文中用 Ogit-Metadata-Begin / Ogit-Metadata-End 包围一段 JSON：operationId、event、action、device、time、branch、upstream、resultTree、parents；整合提交还包含 localCommit、remoteCommit、两个恢复分支名，选边提交另有 strategy、reason。

只读解析：在插件目录执行 `node scripts/read-record.cjs <提交ID> [Vault路径]`。
查看已推送的快照：`git show <恢复分支>:<文件路径>`。LFS 文件显示的是指针，恢复二进制需要在独立 worktree 中执行 lfs pull。

## 操作记录

本机记录位于 Vault 之外的 `%LOCALAPPDATA%/ObsidianCustomGitSync/<仓库ID>/`（非 Windows 为 `~/.local/state/...`），包括 device.txt、state.json、history.jsonl。
每次操作进行时会写 pending.json，结束后追加到 history.jsonl 并删除 pending.json。若在应用到 Vault 的阶段失败，或进程中途退出，pending.json 会保留下来，之后的同步都显示 ×，直到用户核对 Vault 并手动删除该文件。插件不会自动恢复。

## 开发与验证

```text
npm install
npm run build
npm test
```

测试会创建独立的临时本地仓库和 bare 远程仓库，不访问网络；临时目录会打印并保留，供审计。
`npm run build` 会清空并重建 `dist/`；`npm test` 会先执行构建，UI 测试直接加载 `dist/main.js`。
修改 src/ 后，重新构建并把 `dist/` 复制到 Vault 的插件目录，再禁用并启用插件。只修改插件目录里的 config.jsonc 时，重新启用插件即可。
