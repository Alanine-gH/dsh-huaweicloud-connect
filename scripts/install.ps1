<#
.SYNOPSIS
  把 dsh-huaweicloud-connect 安装到 DSH profile（不经过 pnpm）。

.DESCRIPTION
  这个脚本存在的理由：本机 profile 的 pnpm 解析被其它插件的浮动 devDependency
  拖死（`@deepseek-ai/dsh-tools: "*"` → 依赖未发布的 `@deepseek-ai/dsh-type-meta`
  → 404），任何 `dsh plugin add` 都会在 prepare 阶段回滚。

  所以改用「直接放置 + 登记」：
    1. 拷贝插件本体到 <profile>/node_modules/<pkg>
    2. 从已有的 pi-ai 副本拷一份到插件自己的 node_modules（隔离，不动顶层包版本）
    3. 幂等更新 <profile>/package.json 的 dependencies 与 dsh.profile.bundles

.PARAMETER ProfileDir
  DSH profile 目录。默认 %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER Source
  插件源码目录。默认本脚本所在目录的上一级。

.EXAMPLE
  pwsh -File scripts\install.ps1
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$Source = ''
)

# 参数默认值里拿不到 $PSScriptRoot，必须在脚本体里补
if ([string]::IsNullOrEmpty($Source)) { $Source = Split-Path -Parent $PSScriptRoot }
if ([string]::IsNullOrEmpty($ProfileDir)) { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-huaweicloud-connect'

if (-not (Test-Path $ProfileDir)) { throw "profile 目录不存在: $ProfileDir" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "源码目录不像插件（缺 package.json）: $Source" }

Write-Host "源:      $Source"
Write-Host "目标:    $ProfileDir"

$target = Join-Path $ProfileDir "node_modules\$PackageName"

# ── 0. 备份 profile 清单 ──────────────────────────────────────────────────
$backupDir = Join-Path $env:TEMP 'dsh-hc-install-backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($file in 'package.json', 'cordis.patch.yml') {
  $path = Join-Path $ProfileDir $file
  if (Test-Path $path) {
    Copy-Item $path (Join-Path $backupDir "$file.bak-$(Get-Date -Format yyyyMMdd-HHmmss)") -Force
  }
}
Write-Host "备份:    $backupDir"

# ── 1. 拷贝插件本体 ───────────────────────────────────────────────────────
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
robocopy $Source $target /E /NFL /NDL /NJH /NJS /NP /XD node_modules .git test temp | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 插件本体失败 (exit=$LASTEXITCODE)" }
Write-Host "本体:    已复制"

# 测试目录单独拷（体积小，便于在 profile 里直接跑自测）
$testSrc = Join-Path $Source 'test'
if (Test-Path $testSrc) {
  robocopy $testSrc (Join-Path $target 'test') /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

# ── 2. 准备 @earendil-works/pi-ai 依赖树 ──────────────────────────────────
$piAiDest = Join-Path $target 'node_modules'
# 候选来源。注意用 @() 强制成数组：Where-Object 只剩 1 项时结果会退化成标量字符串，
# 此时 $x[0] 取到的是首字符而不是路径（踩过：含空格路径被拆成 "D"）。
$piAiCandidates = @(
  $env:HUAWEICLOUD_PI_AI_SOURCE
  (Join-Path $ProfileDir 'node_modules\dsh-workbuddy-connect\node_modules')
  (Join-Path $ProfileDir 'node_modules\@earendil-works')
  (Join-Path $Source 'temp\wbinstall\node_modules')
  (Join-Path (Split-Path -Parent $Source) 'temp\wbinstall\node_modules')
) | Where-Object {
  $_ -and (Test-Path $_) -and (
    (Test-Path (Join-Path $_ '@earendil-works\pi-ai\package.json')) -or
    (Test-Path (Join-Path $_ 'pi-ai\package.json'))
  )
}
$piAiCandidates = @($piAiCandidates)

if ($piAiCandidates.Count -eq 0) {
  throw @"
没找到可复用的 @earendil-works/pi-ai 依赖树。
本插件依赖 @earendil-works/pi-ai@1.3.0（DSH 0.2.1 系列对应版本）。

三种解决办法，任选其一：
  1) 先安装 dsh-workbuddy-connect（它自带同一份 pi-ai），本脚本会自动复用它那份
  2) 设置环境变量 HUAWEICLOUD_PI_AI_SOURCE，指向一个含 @earendil-works\pi-ai 的 node_modules 目录
  3) 在本仓库同级建好 temp\wbinstall\node_modules（用 pnpm 装一份 pi-ai@1.3.0）
"@
}

# 判断这份候选是「node_modules 根」还是「直接就是 @earendil-works 目录」
$piRoot = if (Test-Path (Join-Path $piAiCandidates[0] '@earendil-works\pi-ai\package.json')) {
  $piAiCandidates[0]
} else {
  Split-Path -Parent $piAiCandidates[0]
}
$piSource = $piRoot
Write-Host "pi-ai:   来自 $piSource"
New-Item -ItemType Directory -Force -Path $piAiDest | Out-Null
$skip = @('.bin', '.pnpm', '.modules.yaml')
Get-ChildItem -LiteralPath $piSource -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
  robocopy $_.FullName (Join-Path $piAiDest $_.Name) /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 依赖失败: $($_.Name) (exit=$LASTEXITCODE)" }
}

# 立即验证关键依赖真的到位，而不是等重启 DSH 才发现
foreach ($must in '@earendil-works\pi-ai\package.json', '@earendil-works\pi-ai\dist\api\openai-completions.lazy.js') {
  $probe = Join-Path $piAiDest ($must -replace '/', '\')
  if (-not (Test-Path $probe)) { throw "依赖不完整，缺少: $must（源目录 $piSource 可能选错了）" }
}
Write-Host "依赖:    已就位并校验通过"

# ── 3. 幂等登记到 package.json ────────────────────────────────────────────
$manifestPath = Join-Path $ProfileDir 'package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json).version

$deps = $manifest.dependencies
$changed = $false
if ($null -eq $deps.PSObject.Properties[$PackageName]) {
  $deps | Add-Member -NotePropertyName $PackageName -NotePropertyValue $version
  $changed = $true
} elseif ($deps.$PackageName -ne $version) {
  $deps.$PackageName = $version
  $changed = $true
}

$bundles = $manifest.dsh.profile.bundles
if ($bundles -notcontains $PackageName) {
  $manifest.dsh.profile.bundles = @($bundles) + $PackageName
  $changed = $true
}

if ($changed) {
  # 关键：绝不能用 Set-Content -Encoding UTF8。Windows PowerShell 5.1 下它会写 UTF-8 BOM，
  # 而 DSH 启动时用 JSON.parse 读 profile 清单，Node 不接受 BOM → Host 进程直接 fatal
  # （报 "Unexpected token '﻿'"），桌面版起不来。必须显式用无 BOM 的 UTF8Encoding。
  $json = $manifest | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "清单:    已更新 package.json (dep + bundles，无 BOM)"
} else {
  Write-Host "清单:    已是声明状态，未改动"
}

# ── 4. 自检：确认没有留下 BOM，且 JSON 仍可解析 ──────────────────────────
# 这一步不是锦上添花：带 BOM 的 package.json 会让 DSH 下次启动直接崩溃，
# 而崩溃发生在「重启之后」，那时早已忘记是本脚本干的。
$problems = @()
foreach ($name in 'package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml') {
  $check = Join-Path $ProfileDir $name
  if (-not (Test-Path $check)) { continue }
  $head = [System.IO.File]::ReadAllBytes($check)[0..([Math]::Min(2, (Get-Item $check).Length - 1))]
  if ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
    $problems += "$name 带 UTF-8 BOM（会让 DSH 启动崩溃）"
  }
}
try {
  $verify = Get-Content (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json
  $bundleCount = $verify.dsh.profile.bundles.Count
} catch {
  $problems += "package.json 解析失败: $($_.Exception.Message)"
  $bundleCount = -1
}

if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host '自检失败：' -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  throw '安装未通过自检，请先修复上面列出的问题再重启 DSH。'
}

Write-Host ''
Write-Host "自检:    通过（BOM 无、JSON 可解析、bundles=$bundleCount）"
Write-Host ''
Write-Host '完成。接下来：'
Write-Host '  1) 完全退出并重启 DeepSeek Harness 桌面版（Host 插件在启动时加载）'
Write-Host '  2) 验证：模型选择器出现 Huawei CodeArts / OfficeAce 两个分组'
$binPath = Join-Path $target 'lib\bin.js'
Write-Host "  3) 诊断：node `"$binPath`" status"
