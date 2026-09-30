# 一键发布笔记到网站
# 用法：右键"使用 PowerShell 运行"，或在终端执行 .\发布.ps1 [-m "备注"]
param(
    [string]$m = ""
)
$ErrorActionPreference = "Stop"
$env:PATH = "D:\develop\node22;$env:PATH"
Set-Location $PSScriptRoot

git add content
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "没有需要发布的改动" -ForegroundColor Yellow
    exit 0
}

$note = if ($m) { $m } else { "更新笔记 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
git commit -m $note
git push
Write-Host "已推送，网站将在 1-2 分钟后自动更新：https://shijinghui-dot.github.io" -ForegroundColor Green
