# 审计与排查

[← 返回 README](../README.md)

插件留下两种记录：写进提交信息的元数据，和保存在本机的操作记录。

## 提交元数据（schemaVersion 3）

提交标题固定为英文，正文中用 Ogit-Metadata-Begin / Ogit-Metadata-End 包围一段 JSON：operationId、event、action、device、time、branch、upstream；整合提交还包含 localCommit、remoteCommit、两个恢复分支名，选边提交另有 strategy。

查看某个提交的元数据：`git show -s --format=%B <提交ID>`。
查看已推送的快照：`git show <恢复分支>:<文件路径>`。LFS 文件显示的是指针，恢复二进制需要在独立 worktree 中执行 lfs pull。

## 操作记录

本机记录位于 Vault 之外的 `%LOCALAPPDATA%/ObsidianOhMyGit/<仓库ID>/`（非 Windows 为 `~/.local/state/...`）：

```text
device.txt           # 保留：本机设备 ID
state.json           # 保留：月度备份进度
history-YYYY-MM.jsonl  # 保留：每次操作的记录（阶段、提交、恢复分支、错误码和 Git 输出），按本地时区的月份分文件
.omg.pending.json    # 临时：进行中操作的记录
.omg.worktree-<id>/  # 临时：合并用的 worktree
```

以 `.omg.` 开头的都是临时产物。正常结束的操作会把记录追加到 history-YYYY-MM.jsonl，并删除 pending。
Obsidian 被强制退出时可能留下残留。插件**启动时**会自动清理：把残留的 pending 以 `outcome: "interrupted"` 归档到 history-YYYY-MM.jsonl，删除所有 `.omg.*`，执行 `git worktree prune`。
插件**从不删除** `index.lock`：残留 pending 只能说明上次同步中断了，不能说明锁是谁的（可能是你之后启动的 Git，比如正在编辑提交信息的 `git commit`）。如果有残留 pending，同时 `index.lock` 存在，会显示阻塞的 ×（`repo`），提示锁文件路径；请确认没有 Git 进程在运行后手动删除，再点重试。
如果在把合并结果应用到 Vault 的途中被打断，下次快照会把已经应用的部分当作本地修改提交，再与远程合并（通常能干净合并）。合并前双方的原始提交都在恢复分支里，不会丢。
插件重新加载时，如果旧实例的同步仍在执行，新实例的这次同步会失败一次（!），等旧实例结束后恢复正常。

## 控制台日志

同步失败时，Git 的原始输出会打印到 Obsidian 的控制台，判定规则见 [同步机制](sync.md) 的「错误怎么判定」一节。
