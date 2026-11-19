# 开发与发版

[← 返回 README](../README.md)

## 目录结构

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
  manual-save.cjs # 虚拟时钟验证手动保存的前后防抖和命令包装
  sync.cjs      # 临时仓库中的同步与数据保护
  config.cjs    # 配置及 Git 错误信息
  setup.cjs     # setup-git.cmd 的 sh 部分
  prune.cjs     # prune-recovery.cjs 的列出与删除
scripts/
  prune-recovery.cjs # 手动清理旧的恢复分支
  setup-git.cmd    # 手动执行的 Vault Git 配置脚本（cmd/sh 双语）
docs/              # 技术文档
config.jsonc       # 带注释的默认配置，同时打包进 main.js
.cnb.yml           # CNB 流水线：同步到 GitHub、nightly、正式版
.github/workflows/ # GitHub 流水线：nightly、正式版
dist/              # 构建产物，即分发内容（不入库）
  manifest.json
  main.js
  config.jsonc
  scripts/prune-recovery.cjs
  scripts/setup-git.cmd
```

## 构建与测试

```text
npm install
npm run build
npm test
```

测试会创建独立的临时本地仓库和 bare 远程仓库，不访问网络；临时目录会打印并保留，供审计。
`npm run build` 会清空并重建 `dist/`；`npm test` 会先执行构建，UI 测试直接加载 `dist/main.js`。
修改 src/ 后，重新构建并把 `dist/` 复制到 Vault 的插件目录，再禁用并启用插件。只修改插件目录里的 config.jsonc 时，重新启用插件即可。

## 发版

**nightly**：`main` 每次更新后，CNB 流水线（`.cnb.yml`）自动测试、构建，把 `nightly` 这个 Tag 移到最新提交，并重建同名的预发布版本，附件为 `dist/` 的全部文件。GitHub 镜像上的 nightly 由 `.github/workflows/nightly.yml` 另行发布：还没有正式版时它被标为 Latest，这样仓库主页的 Releases 侧栏能直接看到；发布第一个正式版后，下一次构建起改回预发布，Latest 留给正式版。

**正式版**：

1. 同步修改 `manifest.json`、`package.json` 的 `version`，并在 `versions.json` 中追加 `"<版本>": "<minAppVersion>"`，提交并合入 `main`。
2. 在该提交上打带附注的 Tag 并推送，Tag 与 `version` 完全一致（不带 `v`）：

   ```text
   git tag -a <版本> -m "<发布说明>"
   git push origin <版本>
   ```

3. CNB 流水线自动完成其余步骤：校验 Tag 与上面三个文件里的版本一致，测试、构建，创建 Release（说明取 Tag 的附注信息），上传 `dist/` 的全部文件。校验或测试失败时不会创建 Release。
4. CNB 发布成功后，流水线把这个 Tag 推到 GitHub。那里的 `.github/workflows/release.yml` 再独立校验、测试、构建一遍，发布同名 Release。Obsidian 社区市场从 GitHub 的 Release 取 `main.js` 和 `manifest.json`。

只有数字开头的 Tag 会触发发布，两边的流水线配置都取自 Tag 所在的提交。其他 Tag 不会同步到 GitHub。
