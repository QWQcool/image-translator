# 组装体验版便携包：在 CI 构建完成后运行（windows-latest + pwsh）。
# 步骤：内置 Node 运行时 → 拷贝构建产物与依赖 → 生成 start.bat / 使用说明 → 压缩 zip。
# 产物：仓库根目录 tuanyi-space-trial-win64.zip（zip 内路径全部 ASCII，避免解压乱码）。

$ErrorActionPreference = 'Stop'

$stage = Join-Path $PWD 'portable-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

# ── 1. 内置 Node 运行时（版本与 runner 构建用 Node 一致，保证原生模块 ABI 兼容）──
$nodeVersion = (node -p 'process.version').Trim()   # 形如 v20.x.x
$nodeZipUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
$nodeZipPath = Join-Path $env:RUNNER_TEMP 'node-portable.zip'
Write-Host "下载内置 Node 运行时: $nodeZipUrl"
Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath

$nodeDir = Join-Path $stage 'node'
Expand-Archive -Path $nodeZipPath -DestinationPath $nodeDir
# 官方 zip 内有一层 node-vX.Y.Z-win-x64 目录，把内容上提到 node/ 根
$inner = Join-Path $nodeDir "node-$nodeVersion-win-x64"
if (Test-Path $inner) {
  Get-ChildItem $inner | Move-Item -Destination $nodeDir
  Remove-Item $inner -Recurse -Force
}

# ── 2. 拷贝应用：构建产物 + 全量依赖 + 配置 + 静态资源 ──
Copy-Item -Path '.next'       -Destination (Join-Path $stage '.next')       -Recurse
Copy-Item -Path 'node_modules' -Destination (Join-Path $stage 'node_modules') -Recurse
Copy-Item -Path 'public'      -Destination (Join-Path $stage 'public')      -Recurse
Copy-Item -Path 'package.json'      -Destination $stage
Copy-Item -Path 'next.config.ts'    -Destination $stage

# ── 3. start.bat（UTF-8 无 BOM：BOM 会导致 cmd 把首行识别为命令而报错；
#        chcp 65001 在文件第 2 行，其后中文按 UTF-8 解码，Win10+ 显示正常）──
$startBat = @'
@echo off
rem 图译空间 体验版一键启动（试用模式：免登录，仅限本机体验，勿暴露公网）
chcp 65001 >nul
title 图译空间（体验版）

cd /d "%~dp0"

rem ---- 运行环境变量：试用模式 + 生产构建 + 仅监听本机回环地址 ----
set "TRIAL_MODE=1"
set "NODE_ENV=production"
set "PORT=3000"
set "DATA_DIR=data"

rem ---- 首次启动生成随机会话密钥并复用（重启后登录态不失效）----
if not exist ".session-secret" (
  node\node.exe -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))" > .session-secret
)
set /p SESSION_SECRET=<.session-secret

echo ============================================================
echo   图译空间 体验版（试用模式）
echo.
echo   服务地址: http://localhost:3000
echo   数据目录: %~dp0data   （备份 = 直接复制此目录）
echo   升级方式: 覆盖解压新版本到本目录，data/ 自动保留
echo   停止服务: 在本窗口按 Ctrl+C
echo.
echo   仅限本机体验，请勿将端口暴露到公网！
echo ============================================================
echo.

rem 4 秒后自动用默认浏览器打开首页（新窗口倒计时，不阻塞服务启动）
start "" cmd /c "timeout /t 4 >nul & start "" http://localhost:3000"

rem 用内置 Node 启动生产服务，绑定 127.0.0.1（不监听外网）
node\node.exe node_modules\next\dist\bin\next start -H 127.0.0.1 -p %PORT%
'@
[IO.File]::WriteAllText((Join-Path $stage 'start.bat'), $startBat, [Text.UTF8Encoding]::new($false))

# ── 4. 使用说明.txt（UTF-8 带 BOM：记事本可正确识别中文编码）──
$readme = @'
图译空间 · 体验版（Windows 64 位）
====================================

【快速开始】
1. 把本压缩包解压到一个独立文件夹（不要解压到系统盘根目录等需管理员权限的位置）
2. 双击 start.bat
3. 稍等几秒，浏览器会自动打开 http://localhost:3000 即可使用（免登录）

【重要提示】
- 本包为「试用模式」：所有功能免登录直接可用，数据仅保存在本机
  （本目录下的 data/ 文件夹），请勿将此服务暴露到公网或转发端口
- Windows 首次运行若弹出 SmartScreen 蓝色提示：
  点「更多信息」→「仍要运行」即可（未签名程序的正常提示）
- 3000 端口被其它程序占用时启动会失败，可关闭占用程序后重试

【数据与备份】
- 全部数据（数据库 + 上传的图片）都在本目录的 data/ 文件夹
- 备份 = 直接复制整个 data/ 目录
- 升级 = 下载新版 zip，覆盖解压到本目录，data/ 会自动保留
- 想彻底清空重来：删除 data/ 文件夹即可

【停止服务】
在 start.bat 的黑色窗口按 Ctrl+C（或直接关闭窗口）

【正式部署】
多人协作 / 公网访问请使用完整部署方案，见项目 README 的「部署到公网」章节：
https://github.com/QWQcool/image-translator#部署到公网
'@
[IO.File]::WriteAllText((Join-Path $stage 'README-使用说明.txt'), $readme, [Text.UTF8Encoding]::new($true))

# ── 5. 压缩（zip 名用 ASCII，避免部分解压工具对中文文件名的编码兼容问题；
#        Release 标题用中文，见 workflow）──
$zipOut = Join-Path $PWD 'tuanyi-space-trial-win64.zip'
if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipOut -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipOut).Length / 1MB, 1)
Write-Host "完成: $zipOut (${sizeMb} MB)"
