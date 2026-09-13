$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$sceneRuntime = if ($env:SCENE_NODE_PATH) { $env:SCENE_NODE_PATH } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'toolchains\node-v24.18.1-win-x64' }
if (Test-Path -LiteralPath "$sceneRuntime\node.exe") { $env:PATH = "$sceneRuntime;" + $env:PATH }
if (!(Test-Path -LiteralPath 'dist\index.html')) {
 if (!(Test-Path -LiteralPath 'node_modules')) { npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' } }
 npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '构建失败' }
}
Write-Host '此间即将启动。请打开 http://127.0.0.1:4173 ，保持这个终端打开。'
node scripts/serve.mjs
