:<<"::END_CMD"
@echo off
rem Oh My Git：为 vault 配置 .gitattributes / .gitignore 并取消跟踪已忽略的文件（cmd/sh 双语脚本）
rem Windows：双击或在 cmd 中运行；macOS/Linux：sh setup-git.cmd
rem 本文件必须保持 LF 换行，否则 sh 部分会失效；因此 cmd 部分不使用 GOTO/标签
setlocal EnableExtensions DisableDelayedExpansion
set "SELF=%~f0"
set "FAIL=(echo ERROR: Git command failed; see the message above & pause & exit /b 1)"

rem 定位 vault：从脚本目录逐级向上，第一个名为 .obsidian 的目录的父目录
set "VAULT="
pushd "%~dp0"
for /l %%n in (1,1,32) do if not defined VAULT for %%d in (".") do if /i "%%~nxd"==".obsidian" (set "VAULT=%%~dpd") else cd ..
popd
if not defined VAULT (echo ERROR: No .obsidian directory above this script & pause & exit /b 1)
cd /d "%VAULT%"
rem 路径经 for 变量输出，避免其中的 & ( ) 被 cmd 当作语法
for %%v in ("%VAULT%") do echo Vault: %%~v

where git >nul 2>nul || (echo ERROR: Git not found; install Git for Windows from https://git-scm.com, then retry & pause & exit /b 1)
git config user.name >nul && git config user.email >nul || (echo ERROR: Git user.name/user.email not set; run git config --global user.name "Your Name" and git config --global user.email you@example.com & pause & exit /b 1)

rem 只以 vault 下是否有 .git 判断：vault 位于其他仓库内时也初始化独立仓库
set "FRESH="
if not exist ".git" set "FRESH=1"
if defined FRESH (
  git lfs version >nul 2>nul || (echo ERROR: Git LFS not found; install it from https://git-lfs.com, then retry & pause & exit /b 1)
  git init -q -b main || %FAIL%
  git lfs install --local >nul || %FAIL%
  echo Initialized Git repository
)
if exist ".git\index.lock" (echo ERROR: .git\index.lock exists; close Obsidian or disable the plugin, then retry & pause & exit /b 1)

rem 区块已存在则跳过；规则来自本文件中 #A/#I 开头的数据行
for %%k in ("A|.gitattributes|OGIT LFS" "I|.gitignore|OGIT IGNORE") do for /f "tokens=1-3 delims=|" %%a in (%%k) do (
  findstr /b /c:"# BEGIN %%c" "%%b" >nul 2>nul && (echo %%b: %%c block exists, skipped) || (
    if exist "%%b" for %%f in ("%%b") do if %%~zf gtr 0 >>"%%b" echo(
    >>"%%b" echo # BEGIN %%c
    for /f "tokens=1* delims= " %%x in ('findstr /b /c:"#%%a " "%SELF%"') do >>"%%b" echo(%%y
    >>"%%b" echo # END %%c
    echo %%b: %%c block added
  )
)

rem 已跟踪但被忽略的文件：取消跟踪，磁盘文件保留
set "UNTRACK="
if not defined FRESH for /f "delims=" %%f in ('git -c core.quotepath=false ls-files -ci --exclude-standard') do (
  echo Untracking: %%f
  set "UNTRACK=1"
)
if defined UNTRACK (
  git ls-files -ci --exclude-standard -z | git --literal-pathspecs rm -q --cached --pathspec-from-file=- --pathspec-file-nul || %FAIL%
)

if defined FRESH (
  git add -A || %FAIL%
  git commit -q -m "ogit: initialize vault (setup-git)" || %FAIL%
  echo Committed initial snapshot
) else (
  git add .gitattributes .gitignore || %FAIL%
  git diff --cached --quiet && (echo Nothing to commit) || (
    git commit -q -m "ogit: apply ignore and LFS rules (setup-git)" || %FAIL%
    echo Committed rule changes
  )
)
echo Done
pause
exit /b 0

rem ---- 数据行：#I 为 .gitignore 规则，#A 为 .gitattributes 规则（与插件默认 lfsExtensions 一致）----
#I **/node_modules/
#I .DS_Store
#I ._*
#I .AppleDouble
#I .LSOverride
#I Icon[! -~]
#I .Spotlight-V100
#I .Trashes
#I .fseventsd
#I .TemporaryItems
#I .DocumentRevisions-V100
#I .trash/
#I .obsidian/workspace.json
#I .obsidian/workspace-mobile.json
#I .obsidian/workspaces.json
#I .obsidian/graph.json
#A *.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text
#A *.[jJ][pP][gG] filter=lfs diff=lfs merge=lfs -text
#A *.[jJ][pP][eE][gG] filter=lfs diff=lfs merge=lfs -text
#A *.[gG][iI][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[wW][eE][bB][pP] filter=lfs diff=lfs merge=lfs -text
#A *.[aA][vV][iI][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[bB][mM][pP] filter=lfs diff=lfs merge=lfs -text
#A *.[iI][cC][oO] filter=lfs diff=lfs merge=lfs -text
#A *.[tT][iI][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[tT][iI][fF][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[hH][eE][iI][cC] filter=lfs diff=lfs merge=lfs -text
#A *.[pP][sS][dD] filter=lfs diff=lfs merge=lfs -text
#A *.[aA][iI] filter=lfs diff=lfs merge=lfs -text
#A *.[pP][dD][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[dD][oO][cC] filter=lfs diff=lfs merge=lfs -text
#A *.[dD][oO][cC][xX] filter=lfs diff=lfs merge=lfs -text
#A *.[xX][lL][sS] filter=lfs diff=lfs merge=lfs -text
#A *.[xX][lL][sS][xX] filter=lfs diff=lfs merge=lfs -text
#A *.[pP][pP][tT] filter=lfs diff=lfs merge=lfs -text
#A *.[pP][pP][tT][xX] filter=lfs diff=lfs merge=lfs -text
#A *.[oO][dD][tT] filter=lfs diff=lfs merge=lfs -text
#A *.[oO][dD][sS] filter=lfs diff=lfs merge=lfs -text
#A *.[oO][dD][pP] filter=lfs diff=lfs merge=lfs -text
#A *.[mM][pP]3 filter=lfs diff=lfs merge=lfs -text
#A *.[wW][aA][vV] filter=lfs diff=lfs merge=lfs -text
#A *.[fF][lL][aA][cC] filter=lfs diff=lfs merge=lfs -text
#A *.[oO][gG][gG] filter=lfs diff=lfs merge=lfs -text
#A *.[mM]4[aA] filter=lfs diff=lfs merge=lfs -text
#A *.[aA][aA][cC] filter=lfs diff=lfs merge=lfs -text
#A *.[mM][pP]4 filter=lfs diff=lfs merge=lfs -text
#A *.[mM][oO][vV] filter=lfs diff=lfs merge=lfs -text
#A *.[mM][kK][vV] filter=lfs diff=lfs merge=lfs -text
#A *.[aA][vV][iI] filter=lfs diff=lfs merge=lfs -text
#A *.[wW][eE][bB][mM] filter=lfs diff=lfs merge=lfs -text
#A *.[zZ][iI][pP] filter=lfs diff=lfs merge=lfs -text
#A *.7[zZ] filter=lfs diff=lfs merge=lfs -text
#A *.[rR][aA][rR] filter=lfs diff=lfs merge=lfs -text
#A *.[gG][zZ] filter=lfs diff=lfs merge=lfs -text
#A *.[bB][zZ]2 filter=lfs diff=lfs merge=lfs -text
#A *.[xX][zZ] filter=lfs diff=lfs merge=lfs -text
#A *.[tT][aA][rR] filter=lfs diff=lfs merge=lfs -text
#A *.[eE][pP][uU][bB] filter=lfs diff=lfs merge=lfs -text
#A *.[wW][oO][fF][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[wW][oO][fF][fF]2 filter=lfs diff=lfs merge=lfs -text
#A *.[tT][tT][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[oO][tT][fF] filter=lfs diff=lfs merge=lfs -text
#A *.[eE][xX][eE] filter=lfs diff=lfs merge=lfs -text
#A *.[dD][lL][lL] filter=lfs diff=lfs merge=lfs -text
::END_CMD
# ---- sh 部分：逻辑与上方 cmd 部分逐段对应 ----
set -eu
case "$(uname)" in Darwin) OS=mac; PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" ;; *) OS=other ;; esac
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
die() { echo "ERROR: $*" >&2; exit 1; }
hint() { if [ "$OS" = mac ]; then echo "run brew install $1"; else echo "install $1 with your package manager"; fi; }

# 定位 vault：从脚本目录逐级向上，第一个名为 .obsidian 的目录的父目录
dir="$(dirname "$SELF")"
while [ "$(basename "$dir")" != .obsidian ]; do
  [ "$dir" = / ] && die "No .obsidian directory above $SELF"
  dir="$(dirname "$dir")"
done
VAULT="$(dirname "$dir")"
cd "$VAULT"
echo "Vault: $VAULT"

command -v git >/dev/null || die "Git not found; $(hint git), then retry"
{ git config user.name && git config user.email; } >/dev/null || die "Git user.name/user.email not set; run git config --global user.name \"Your Name\" and git config --global user.email you@example.com"

# 只以 vault 下是否有 .git 判断：vault 位于其他仓库内时也初始化独立仓库
FRESH=
[ -e .git ] || FRESH=1
if [ -n "$FRESH" ]; then
  git lfs version >/dev/null 2>&1 || die "Git LFS not found; $(hint git-lfs), then retry"
  git init -q -b main
  git lfs install --local >/dev/null
  echo "Initialized Git repository"
fi
[ -e .git/index.lock ] && die ".git/index.lock exists; close Obsidian or disable the plugin, then retry"

# 区块已存在则跳过；规则来自本文件中 #A/#I 开头的数据行
block() {
  if grep -qs "^# BEGIN $3" "$2"; then echo "$2: $3 block exists, skipped"; return; fi
  if [ -s "$2" ]; then
    [ -n "$(tail -c1 "$2")" ] && echo >> "$2"
    echo >> "$2"
  fi
  { echo "# BEGIN $3"; sed -n "s/^#$1 //p" "$SELF"; echo "# END $3"; } >> "$2"
  echo "$2: $3 block added"
}
block A .gitattributes "OGIT LFS"
block I .gitignore "OGIT IGNORE"

# 已跟踪但被忽略的文件：取消跟踪，磁盘文件保留
if [ -z "$FRESH" ]; then
  list="$(git -c core.quotepath=false ls-files -ci --exclude-standard)"
  if [ -n "$list" ]; then
    printf '%s\n' "$list" | sed 's/^/Untracking: /'
    git ls-files -ci --exclude-standard -z | git --literal-pathspecs rm -q --cached --pathspec-from-file=- --pathspec-file-nul
  fi
fi

if [ -n "$FRESH" ]; then
  git add -A
  git commit -q -m "ogit: initialize vault (setup-git)"
  echo "Committed initial snapshot"
else
  git add .gitattributes .gitignore
  if git diff --cached --quiet; then echo "Nothing to commit"; else
    git commit -q -m "ogit: apply ignore and LFS rules (setup-git)"
    echo "Committed rule changes"
  fi
fi
echo "Done"
