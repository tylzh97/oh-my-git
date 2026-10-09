# Custom Git Sync 0.3.0

仅桌面端，Obsidian >= 1.8.7。UI 跟随 Obsidian 中文/英文设置。

## 配置与目录

可调参数集中在插件目录的 `config.json`，启动时读取一次；修改后禁用再启用插件。配置缺失时使用构建时打包的默认值；文件损坏、无法读取或配置值无效时显示 ×，修正后重新启用插件。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| syncIntervalSeconds | 300 | 普通定时同步间隔，整数秒 |
| gitTimeoutSeconds | 120 | 单条 Git 命令超时，整数秒 |
| maxFileMiB | 30 | 插件提交的单文件上限，整数 MiB |
| successDisplayMs | 1000 | 成功 √ 的显示时长，整数毫秒，允许 0 |
| monthlyBackupEnabled | true | 是否创建、补传可选月度备份 |
| lfsExtensions | 见配置文件 | LFS 扩展名，不含点或通配符；兼容大小写，允许空列表 |

省略的字段使用默认值，未知字段视为配置错误。修改 LFS 扩展名会改变当前 `.gitattributes` 的 OGIT 区块和当前文件的跟踪方式，不重写历史。

```text
src/
  main.ts       # Obsidian 事件、状态栏和交互
  sync.ts       # 快照、保护、合并、推送和月度备份
  git.ts        # Git 执行及错误分类
  config.ts     # 默认值、配置读取和校验
tests/
  ui.cjs        # 状态、交互和重试模式
  sync.cjs      # 临时仓库中的同步与数据保护
  config.cjs    # 配置及错误分类
scripts/
  read-record.cjs
config.json
main.js         # Obsidian 实际加载的构建产物
```

## 启用条件

- 系统 PATH 中可执行 Git >= 2.38 和 git lfs；Obsidian 进程必须能找到它们。
- Vault 本身就是 Git 根目录，已有首次提交，普通工作分支配置远程 upstream。
- 当前分支不能以 ogit/ 开头；本地和远程历史允许 merge commit。
- 配置 user.name、user.email，认证与签名应能在非交互环境完成。
- 不支持浅克隆、稀疏检出、子模块、符号链接、SHA-256 仓库、assume-unchanged/skip-worktree 标记、Windows 大小写路径冲突。
- 已有暂存内容、未完成 Git 操作或 index.lock 会阻止同步。不删除用户 Git 锁、不自动 abort 用户操作。

插件不会安装 Git、初始化仓库、设置 upstream，也不会强推工作分支。
首次启用真实版本后会自动同步：请先确认远程与忽略规则，node_modules 已由插件自己的 .gitignore 排除。
Vault 的 .gitignore 完全由用户维护，插件不会创建或修改它；插件目录内的 .gitignore 仅排除插件的开发依赖、日志和构建缓存。被忽略的文件、空目录、尚未落盘的编辑内容不属于 Git 备份范围。

## 钩子和状态

onLoad：提交本地磁盘变化 → fetch upstream → 必要时保护双方 → 临时工作区 merge → 安全应用 → 普通 push → 月度备份。
其他普通入口（onOpen/onSave/onClose/onCron/onClick）：提交整个仓库 → 普通 push → 月度备份。不自动拉取/合并。
日常 push 被拒绝后，fetch 仅用于诊断及恢复快照，不整合工作区。
onResolve：再次捕获双方最新内容并保护，整仓库选择一侧，新增保留双方历史的处理提交，普通 push。
onRetry：仅用于用户点击 × 菜单中的“重试”，重跑失败任务的原模式；启动重试可 fetch/merge，日常重试仍只提交/push；已选择的 local/remote 策略保留。元数据记录 event=onRetry 和 retryOf。
onCron 默认每 5 分钟触发，由 syncIntervalSeconds 配置。onSave 仍使用 vault.modify，不改为保存快捷键。
onUnload：仅记录、清理和请求取消；正在执行的 Git 命令完成后不再启动后续步骤，不强杀写操作。

同步中（包括成功 √ 的显示期间）直接丢弃新触发。

| 状态 | 行为 |
| --- | --- |
| 同步图标 | 接收普通事件 |
| 旋转图标 | 正在同步，丢弃重复触发 |
| 绿色 √ | 已成功，短暂显示后回到待机 |
| 黄色 ! | 提示上次临时连接故障，普通事件继续正常触发同步 |
| 红色 × | 需要人工处理；暂停普通事件，可从菜单重试 |

! 只显示上次失败。打开、修改、关闭文件、定时检查及点击仍按各自事件正常同步；不保存失败任务，不自动重跑原始启动流程或已选择的 local/remote 策略。没有网络重试机制、次数统计、退避或额外定时器。
只有明确的临时连接错误、连接重置或 HTTP 429/502/503/504 才进入 !。认证、权限、证书、hook 拒绝、冲突、配置错误、已有暂存内容、文件超限、仓库锁及无法分类的失败均进入 ×。Git 命令超时或应用结果不确定时停在 ×，保留 pending.json 供人工核对，不自动重试。
点击 × 可选择“重试”；历史冲突/远程领先额外提供“保持远程/保持本地”。启动配置错误需修正后重新启用插件。
插件不提供恢复、诊断或人工处理面板，也不会自动恢复数据。

## 数据保护与合并历史

整合前，本地和远程各有不可变恢复分支并确认已推送；结果也保存到独立 result 分支。
临时 worktree 发生冲突不写入 Vault，两个原始提交保持可恢复。
应用结果前使用 Git status/diff 检查工作区与暂存区，核对 HEAD、分支、upstream/远程地址，并检查未跟踪/忽略文件阻碍。插件不自行读取文件计算内容 hash；哈希仅用于仓库/远程地址/分支名称标识。
使用两树 read-tree 安全检出和 update-ref 的旧值校验，不在 Vault 使用 reset --hard 或 clean。
机器无法保证文件系统与 Git refs 跨步骤原子更新；中断或不确定结果会停在 ×，要求人工核对。
工作区应用与快照之间新增的修改不会自动舍弃，检查发现时停止。
无法防止别的程序在最后一次检查后同时写文件；修改中的重要文档应先落盘，异常中断时按下面流程检查。

保持本地/远程选择整个 Git 跟踪文件树，以最新 upstream 为第一父提交；当它尚未包含本地历史时，以本地快照为第二父提交。自动整合采用 Git merge（可快进），不使用 rebase 重写原有提交。
LFS 规则规范化是额外的跟踪配置变化，选择远程时也会补齐必要的 .gitattributes。
已有人工提交与消息保持原样。自动 merge 和手动选择提交均记录双方原始提交、恢复分支、结果 tree ID 和父提交列表。
记录中的 resultTree 是选择后最终 Git 文件树，包括必要的 LFS 规则。
恢复快照不自动删除，远程生命周期管理若删除这些 refs/LFS 对象将影响可恢复性。

## 分支命名

- ogit/monthly/YYYY-MM/<安全分支名>-<分支名 SHA256 前8位>
- ogit/recovery/<原因>/<UTC毫秒时间>-<本机设备ID>-<随机ID>/local
- 同上 /remote 和 /result；检测远程历史改写时另有 /previous-remote
- 原因：startup-merge、push-rejected、remote-rewritten、keep-local、keep-remote。

月份使用设备本地时区。首次成功推送后创建当月备份，已有不覆盖、不补未运行月份。
多个设备同时创建时采用 create-only lease，不能覆盖已有月度分支；工作分支绝不使用 force。
月度备份是可选的：失败只记录控制台日志，不显示 × 或通知，不影响主线同步成功。失败的分支及首次成功提交保存在 Vault 外的 monthly-pending.json；同一月份的后续日常同步不反复补传，下次启动（或启动任务的手动重试）补传。跨月启动也会补传此前实际尝试过的失败备份，不补从未运行的月份；记录按 upstream 和远程地址摘要匹配。

## 插件内提交大小检查

所有插件发起的 commit（快照、自动 merge、手动版本选择）先执行同一检查。不安装 pre-commit，不修改 core.hooksPath，不覆盖用户 hook；终端或其他工具的提交不受此限制。既有 Git LFS pre-push 集成保持原样。

默认上限为 30 MiB（31,457,280 字节），由 maxFileMiB 配置，恰好等于上限允许。只检查本次暂存的新增/修改项，删除跳过，已有历史不扫描或迁移。
普通文件大小由 git cat-file --batch-check 读取暂存 blob；LFS 指针用 Git LFS 原生 pointer --check 验证，并检查声明大小和本地 LFS 对象的实际大小。不能用小指针绕过上限。
超限时显示 ×，悬停和控制台列出路径、大小；不删除文件、不取消暂存、不执行 commit 或 push。用户自行处理暂存内容后点击重试。超限内容只有本地文件/LFS 对象，尚未获得插件的远程备份。
Git hook 若在检查后改写提交的文件树或父提交，插件会停止后续推送，并留下本地提交及操作记录供手动检查。

## LFS

生成 .gitattributes 的 OGIT LFS 区块；不删除区块外的用户规则。
默认跟踪图片、PDF、Office/开放文档、音视频、压缩包、电子书、字体及 exe/dll 的常见扩展名，规则由 lfsExtensions 配置并兼容大小写。
默认 SVG、Markdown、JSON 等文本继续普通 Git。
当前版本二进制使用 LFS 指针；已存在历史不自动重写迁移。
嵌套 .gitattributes 覆盖规则或不正确的当前指针会阻止同步。
每次保护恢复分支、工作分支及月度分支均显式执行 LFS 上传；上传不成功不宣称备份完成。
不会覆盖自定义 pre-push hook；若 git lfs install 报 hook 冲突，请自行整合 Git LFS hook 后重试。

## 提交元数据（schemaVersion 2）

标题固定英文，正文由 Ogit-Metadata-Begin / Ogit-Metadata-End 包围 JSON。只读解析脚本兼容旧 schemaVersion 1 和当前 2。
所有自动快照包含 operationId、event、action、device、time、branch、upstream、stats、resultTree、parents。
每次手动选择都有提交（允许空树变化），额外包含 strategy、reason、localCommit、remoteCommit、localRecoveryRef、remoteRecoveryRef、resultTree、parents。
这些字段可用于 git show、创建恢复 worktree，以及生成新的恢复提交；不要把恢复理解为 reset/强推。

只读解析：在插件目录执行 `node scripts/read-record.cjs <完整或短十六进制提交ID> [Vault路径]`。
查看已推送的快照：`git show <恢复分支>:<文件路径>`。LFS 文件此时显示指针，恢复实际二进制需在独立 worktree 中安装 LFS 并执行 lfs pull。
Git 指针和 LFS 对象都要保留；仅有 JSON 消息而已删除对象不能恢复内容。

## 中断核对

本机操作记录位于 `%LOCALAPPDATA%/ObsidianCustomGitSync/<仓库ID>/`，Vault 外，不参与同步。
包含 device.txt、state.json、history.jsonl；进行中或无法确认的操作留下 pending.json。
仓库 Git common directory 中有 ogit-sync.lock，内容记录 PID 和本机记录路径。

× 状态下的失败、锁定和中断需用户自行处理。插件不会删除用户锁或自动恢复文件；只保留备份和操作记录。只读 JSON 解析脚本不执行恢复操作。

## 开发与验证

npm install
npm run build
npm test

测试创建独立临时本地与 bare 远程仓库，不使用真实 Vault/远程，不访问网络服务。
测试临时目录会打印并保留以便审计。
修改 src/ 中的源码后必须重新构建 main.js，禁用再启用插件。只修改外部 config.json 时重新启用插件即可，无需构建。
Ctrl+Shift+I → Console 查看 [Custom Git Sync] 日志；Git 原始输出不打印，避免泄漏 remote URL/凭据。
Git 子命令默认超时为 120 秒，由 gitTimeoutSeconds 配置；操作开始后的超时留下 pending.json 要求核对。




