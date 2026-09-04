@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title 漫画翻译站 - 本地 AI 环境一键配置

echo ============================================================
echo   本地 AI 环境一键配置（Ollama + Qwen3 系列）
echo   纯原生脚本，零第三方依赖，可随时 Ctrl+C 退出
echo ============================================================
echo.

rem ---------- 1. 检测 ollama 是否在 PATH ----------
set OLLAMA_OK=0
where ollama >nul 2>&1
if errorlevel 1 (
    echo [未找到] PATH 中没有 ollama 命令。
    echo          请先到官网下载安装：https://ollama.com/download
    echo          安装后重新打开终端再运行本脚本，或继续用本脚本完成硬件诊断。
) else (
    set OLLAMA_OK=1
    echo [OK] 已找到 ollama：
    for /f "delims=" %%v in ('ollama --version 2^>nul') do echo      %%v
)
echo.

rem ---------- 2. 硬件诊断：显卡与显存 ----------
set GPU_NAME=
set VRAM_MB=
for /f "usebackq delims=" %%i in (`nvidia-smi --query-gpu=name --format=csv,noheader 2^>nul`) do if not defined GPU_NAME set GPU_NAME=%%i
for /f "usebackq delims=" %%i in (`nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2^>nul`) do if not defined VRAM_MB set VRAM_MB=%%i

if defined VRAM_MB (
    set /a VRAM_GB=VRAM_MB/1024
    echo [GPU] 检测到 N 卡：!GPU_NAME!
    echo       显存：!VRAM_MB! MB（约 !VRAM_GB! GB）
) else (
    echo [提示] 未检测到 N 卡（nvidia-smi 不可用），回退查询 CPU 核数与内存容量：
    set RAM_GB=
    set CPU_CORES=
    for /f "delims=" %%i in ('powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)" 2^>nul') do set RAM_GB=%%i
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1).NumberOfCores" 2^>nul') do set CPU_CORES=%%i
    if defined RAM_GB (
        echo       CPU 核数：!CPU_CORES! · 内存容量：!RAM_GB! GB
    ) else (
        echo       [警告] 硬件信息查询失败，将默认按最低档（3B）处理。
    )
    set VRAM_MB=0
)
echo.

rem ---------- 3. 档位匹配 ----------
set TEXT_MODEL=qwen3:3b
set TIER_NAME=轻量档（CPU/核显可跑）
set PULL_VISION=0
set GAP_NOTE=

if %VRAM_MB% GEQ 24576 (
    set TEXT_MODEL=qwen3:32b
    set TIER_NAME=旗舰档
    set PULL_VISION=1
) else if %VRAM_MB% GEQ 12288 (
    set TEXT_MODEL=qwen3:14b
    set TIER_NAME=高阶档
    set PULL_VISION=1
    if %VRAM_MB% GEQ 17408 if %VRAM_MB% LSS 24576 set GAP_NOTE=（你的显存介于 16~24G 之间，按就近原则选了 14B；显存富余也可手动改用 qwen3:32b）
) else if %VRAM_MB% GEQ 6144 (
    set TEXT_MODEL=qwen3:8b
    set TIER_NAME=主流档
    set PULL_VISION=1
    if %VRAM_MB% GTR 10240 if %VRAM_MB% LSS 12288 set GAP_NOTE=（你的显存介于 10~12G 之间，按就近原则选了 8B；也可手动改用 qwen3:14b）
) else (
    set TEXT_MODEL=qwen3:3b
    set TIER_NAME=轻量档
)

echo [档位] 推荐配置：!TIER_NAME!
echo        对话模型：!TEXT_MODEL!
if defined GAP_NOTE echo        说明：!GAP_NOTE!
if "%PULL_VISION%"=="1" (
    echo        视觉模型：qwen3-vl:8b（OCR 出框用）
) else (
    echo        视觉模型：不拉取（3B 档识别走云端服务或纯算法出框）
)
echo.

rem ---------- 4. 设置 OLLAMA_ORIGINS 跨域变量（用户级，防重复） ----------
reg query "HKCU\Environment" /v OLLAMA_ORIGINS >nul 2>&1
if errorlevel 1 (
    setx OLLAMA_ORIGINS "*" >nul
    echo [已设置] 用户级环境变量 OLLAMA_ORIGINS = * （请重开终端生效）
) else (
    for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v OLLAMA_ORIGINS 2^>nul') do set CURRENT_ORIGINS=%%b
    echo "!CURRENT_ORIGINS!" | findstr /C:"*" >nul
    if errorlevel 1 (
        setx OLLAMA_ORIGINS "*" >nul
        echo [已更新] OLLAMA_ORIGINS 原值为 "!CURRENT_ORIGINS!"，已改为 *（重开终端生效）
    ) else (
        echo [跳过] OLLAMA_ORIGINS 已存在且为 "*"，无需重复设置。
    )
)
echo.

rem ---------- 5. 询问确认后拉取模型 ----------
if not "%OLLAMA_OK%"=="1" (
    echo [跳过] 未安装 ollama，跳过模型拉取。请先到 https://ollama.com/download 安装。
    goto SUMMARY
)
set CONFIRM=
set /p CONFIRM=是否现在拉取模型（!TEXT_MODEL! 等，共数 GB，请确保网络畅通）？[Y/N]:
if /i not "%CONFIRM%"=="Y" (
    echo [跳过] 已取消拉取，可稍后手动执行 ollama pull !TEXT_MODEL!
    goto SUMMARY
)
echo.
echo [1/2] 正在拉取文本模型 !TEXT_MODEL! ...
ollama pull !TEXT_MODEL!
if errorlevel 1 (
    echo [失败] 模型拉取失败，请检查网络或到 https://ollama.com/library 手动下载。
) else (
    echo [完成] !TEXT_MODEL! 拉取成功。
)
if "%PULL_VISION%"=="1" (
    echo [2/2] 正在拉取视觉模型 qwen3-vl:8b ...
    ollama pull qwen3-vl:8b
    if errorlevel 1 (
        echo [失败] 视觉模型拉取失败，请检查网络或到 https://ollama.com/library 手动下载。
    ) else (
        echo [完成] qwen3-vl:8b 拉取成功。
    )
) else (
    echo [2/2] 轻量档跳过视觉模型：漫画识别改走云端 API 或纯算法出框，翻译质量不受影响。
)
echo.

rem ---------- 6. 汇总：本站 AI 设置要填的参数 ----------
:SUMMARY
echo ============================================================
echo   配置完成！回到本站「AI 设置」页填写以下参数：
echo ------------------------------------------------------------
echo    Base URL  ： http://127.0.0.1:11434/v1
echo    对话模型  ： !TEXT_MODEL!
if "%PULL_VISION%"=="1" (
    echo    视觉模型  ： qwen3-vl:8b
) else (
    echo    视觉模型  ： 留空（走云端或纯算法）
)
echo    API Key   ： ollama（随便填即可，本地不校验）
echo ------------------------------------------------------------
echo   小技巧：AI 设置页表单顶部的「快速模板」下拉，
echo   选 "[本地-...] Ollama" 可一键填入以上参数。
echo ============================================================
endlocal
