<#
  build.ps1 — 一键打包商店提交 zip（Tab-Volume-999-<version>.zip）

  用法：
      powershell -ExecutionPolicy Bypass -File .\tools\build.ps1

  行为：
    1. 读取 manifest.json 的 version（如 1.0.1）；
    2. 把整个项目目录（排除 .git）打包到上级目录：
       Tab-Volume-999-<version>.zip（如 S:\VSR\Tab-Volume-999-1.0.1.zip）；
    3. 打印输出路径，方便直接上传 Partner Center 或 GitHub Release。
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录（含 manifest.json）
$outDir = Split-Path -Parent $root               # 输出目录（项目上级）

# 1) 读取版本号
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw 'manifest.json 中缺少 version 字段' }

# 2) 打包（排除 .git）
$zipPath = Join-Path $outDir "Tab-Volume-999-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Get-ChildItem -Path $root -Force |
  Where-Object Name -ne '.git' |
  Compress-Archive -DestinationPath $zipPath -Force

Write-Host "✓ 已生成商店提交包：" -NoNewline
Write-Host " $zipPath"
