# Creates junction mirrors of a dsh-meow pnpm workspace's @deepseek-ai/*
# packages under this plugin's node_modules, so esbuild can resolve both this
# plugin's direct imports and the transitive imports of bundled packages.
#
# The built lib/index.js is self-contained (esbuild bundles everything), so
# these links are only needed at BUILD time, never at runtime.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1 -MeowRoot D:\path\to\dsh-meow
#
# This script is Windows-only (NTFS junctions). On macOS/Linux, replace the
# junction with a symlink (ln -s) — the layout is identical.
#
# 注意：npm install 会清掉非依赖树内的 junction，装完包要重跑本脚本。
# dsh-llm external 化（PR #88）后 build 不再需要 junction；直接 node 跑
# lib/index.js 的本地测试（test.mjs）仍需要。

param(
  [string]$MeowRoot = "D:\myFiles\dsh\dsh-meow"
)

$ErrorActionPreference = 'Stop'
# 规范化掉 ..（Join-Path $PSScriptRoot "..\..." 留下的点段在某些 cmdlet 里行为不一）
$linkRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\node_modules\@deepseek-ai"))
New-Item -ItemType Directory $linkRoot -Force | Out-Null
$created = 0
$skipped = 0

if (-not (Test-Path (Join-Path $MeowRoot "pnpm-workspace.yaml"))) {
  # 缺 workspace（外部贡献者 / CI 干净安装）不挡构建：dsh-llm 已 external（PR #88），
  # 只有直接 node 跑 lib/index.js 的本地测试才需要 junction——提示手动补，不强求。
  Write-Host "WARN: $MeowRoot does not look like a dsh-meow workspace (pnpm-workspace.yaml missing); skipping junction mirrors"
  exit 0
}

# -Depth 3：现行布局是 packages/<组>/<包> 两层（如 packages/llm/llm），
# 旧的 -Depth 1 扫不到（2026-10-31 npm install 清掉镜像后 build 全红的教训）。
# 用 foreach 内联而非管道+函数：管线版在部分环境下静默不创建（2026-10-31 实证）。
$roots = @((Join-Path $MeowRoot "packages"), (Join-Path $MeowRoot "vendor"))
$dirs = $roots | ForEach-Object { Get-ChildItem $_ -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue }
foreach ($d in $dirs) {
  $pjFile = Join-Path $d.FullName "package.json"
  if (-not (Test-Path $pjFile)) { continue }
  try {
    $raw = [System.IO.File]::ReadAllText($pjFile, [System.Text.Encoding]::UTF8)
    $pj = $raw | ConvertFrom-Json
    if ($pj.name -and $pj.name.StartsWith("@deepseek-ai/")) {
      $name = $pj.name.Substring(13)
      $link = Join-Path $linkRoot $name
      if (-not (Test-Path $link)) {
        New-Item -ItemType Junction -Path $link -Target $d.FullName | Out-Null
        $created++
      } else {
        $skipped++
      }
    }
  } catch {
    Write-Host "skip $($d.FullName): $($_.Exception.Message)"
  }
}

Write-Host "created $created new junctions (already present: $skipped); total: $((Get-ChildItem $linkRoot).Count) in $linkRoot"
