<#
  build.ps1 — 一键打包商店提交 zip

  版本号策略（语义版本 + 日期构建号）：
    - manifest.json 的 version 是"语义版本"（如 1.0.1），手动管理；
    - 每次打包自动附加"构建号"= 当前日期时间，构成 4 段完整版本，
      如 1.0.1.202608181530（Edge 扩展版本最多 4 段，第 4 段递增即可更新）；
    - zip 文件名 = Tab-Volume-999-<完整版本>.zip，同一版本每次打包都不同。

  用法：
      # 仅生成带时间戳的 zip（manifest.json 不动）
      powershell -ExecutionPolicy Bypass -File .\tools\build.ps1

      # 同时把完整版本写回 manifest.json（推荐在发版时用）
      powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -StampManifest

      # 只按语义版本打包（不加 build 段）
      powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -NoStamp
#>
param(
  [switch]$StampManifest,  # 把"完整版本（含日期 build 段）"写回 manifest.json
  [switch]$NoStamp         # 不使用日期 build 段，只用语义版本
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$outDir = Split-Path -Parent $root               # 输出目录（项目上级）

# 1) 读语义版本（去掉可能已存在的 build 段，保留前 3 段）
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$parts = $manifest.version -split '\.'
$semVer = ($parts[0..([math]::Min(2, $parts.Count - 1))] -join '.')

# 2) 拼完整版本 = 语义版本 + 日期时间 build 段
if ($NoStamp) {
  $fullVer = $semVer
} else {
  $build = Get-Date -Format 'yyyyMMddHHmm'
  $fullVer = "$semVer.$build"
}

# 3) 可选：把完整版本写回 manifest（保证商店里看到的就是本包版本）
if ($StampManifest) {
  $manifest.version = $fullVer
  $manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding UTF8
  Write-Host "✓ 已更新 manifest.json version → $fullVer"
}

# 4) 打包（排除 .git / tools / .gitignore 等非扩展文件）
$zipPath = Join-Path $outDir "Tab-Volume-999-$fullVer.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Get-ChildItem -Path $root -Force |
  Where-Object Name -ne '.git' |
  Where-Object Name -ne 'tools' |
  Where-Object Name -ne '.gitignore' |
  Compress-Archive -DestinationPath $zipPath -Force

Write-Host "✓ 已生成商店提交包： $zipPath"
Write-Host "  语义版本：$semVer ｜ 完整版本：$fullVer"
