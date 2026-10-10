import { getLanguage } from "obsidian";
import type { ErrorCode } from "./git";

type Lang = "en" | "zh";
// 每个条目必须包含所有语言，漏写时编译报错
type Text = Record<Lang, string>;

const UI = {
  idle: {
    en: "Git Sync",
    zh: "Git Sync",
  },
  syncing: {
    en: "Git Sync: Syncing…",
    zh: "Git Sync：同步中",
  },
  success: {
    en: "Git Sync: Synced",
    zh: "Git Sync：同步成功",
  },
  resolve: {
    en: "Click for options",
    zh: "点击处理",
  },
  warning: {
    en: "Last sync failed; normal sync remains available",
    zh: "上次同步失败，后续同步正常触发",
  },
  reload: {
    en: "Fix the problem and reload the plugin",
    zh: "处理问题后重新启用插件",
  },
  repeated: {
    en: "Failed repeatedly; sync keeps trying",
    zh: "连续多次失败，同步仍在继续尝试",
  },
  retry: {
    en: "Retry",
    zh: "重试",
  },
  keepRemote: {
    en: "Keep remote",
    zh: "保持远程",
  },
  keepLocal: {
    en: "Keep local",
    zh: "保持本地",
  },
} satisfies Record<string, Text>;

// 键由 ErrorCode 约束：新增错误码而未写文案时编译报错
const ERRORS: Record<ErrorCode, Text> = {
  config: {
    en: "Cannot read config.jsonc",
    zh: "config.jsonc 无法读取",
  },
  repo: {
    en: "Repository is not ready for sync; see console",
    zh: "仓库状态不满足同步条件，见控制台",
  },
  unfinished: {
    en: "A Git merge/cherry-pick/revert/rebase is unfinished; sync resumes after you finish or abort it",
    zh: "仓库有未完成的 Git 操作（merge/cherry-pick/revert/rebase），完成或取消后自动恢复",
  },
  remote: {
    en: "Cannot reach or authenticate with the remote; see console",
    zh: "无法连接远程或认证失败，见控制台",
  },
  refused: {
    en: "Remote refused the push (hook, protected branch or permission); see console",
    zh: "远程拒绝推送（hook、受保护分支或权限），见控制台",
  },
  conflict: {
    en: "History conflict needs a repository-wide choice",
    zh: "历史冲突，需要选择整个仓库的版本",
  },
  size: {
    en: "Files over the size limit were skipped; everything else is synced",
    zh: "超过上限的文件已跳过，其余内容已同步",
  },
  failed: {
    en: "Last sync failed; see console",
    zh: "上次同步失败，见控制台",
  },
  // 安装后进程 PATH 不会更新，需重启 Obsidian
  nogit: {
    en: "Git not found; install Git, then restart Obsidian",
    zh: "未找到 Git，请安装 Git 后重启 Obsidian",
  },
  nolfs: {
    en: "Git LFS not found; install Git LFS, then restart Obsidian",
    zh: "未找到 Git LFS，请安装 Git LFS 后重启 Obsidian",
  },
};

// macOS 下给出 Homebrew 命令；插件运行时已追加 Homebrew 目录，装好后重试即可，无需重启
const MAC_ERRORS: Partial<Record<ErrorCode, Text>> = {
  nogit: {
    en: "Git not found; run `brew install git` in Terminal, then retry",
    zh: "未找到 Git，请在终端执行 brew install git 后重试",
  },
  nolfs: {
    en: "Git LFS not found; run `brew install git-lfs` in Terminal, then retry",
    zh: "未找到 Git LFS，请在终端执行 brew install git-lfs 后重试",
  },
};

// 每次调用时读取 Obsidian 语言设置
function lang(): Lang {
  return getLanguage().toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function t(key: keyof typeof UI): string {
  return UI[key][lang()];
}

export function errorText(code: ErrorCode): string {
  const text = (process.platform === "darwin" && MAC_ERRORS[code]) || ERRORS[code];
  return text[lang()];
}
