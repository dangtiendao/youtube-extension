$ErrorActionPreference = "Stop"

$rootDir  = Split-Path -Parent $PSScriptRoot
$hostSrc  = Join-Path $rootDir "installer\launcher\HostLauncher.cs"
$traySrc  = Join-Path $rootDir "installer\launcher\TrayApp.cs"
$iconFile = Join-Path $rootDir "installer\assets\tubevault.ico"
$outDir   = Join-Path $rootDir "installer\bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Ensure custom .ico exists before compiling executables
if (-not (Test-Path $iconFile)) {
    node (Join-Path $rootDir "scripts\generate-icon.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Failed generating tubevault.ico" }
}

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    throw "Windows .NET C# compiler not found at $csc"
}

# 1. Chrome Native Messaging Host launcher (binary stdio proxy, hidden node.exe child)
$hostExe = Join-Path $outDir "ytdl-host.exe"
& $csc /nologo /optimize+ /target:exe /win32icon:$iconFile /out:$hostExe $hostSrc
if ($LASTEXITCODE -ne 0) { throw "Failed compiling ytdl-host.exe" }

# 2. Windows System Tray application (winexe subsystem -> NotifyIcon, dynamic port via runtime.json, zero console)
$trayExe = Join-Path $outDir "TubeVault.exe"
& $csc /nologo /optimize+ /target:winexe /win32icon:$iconFile /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:$trayExe $traySrc
if ($LASTEXITCODE -ne 0) { throw "Failed compiling TubeVault.exe" }

Write-Host "[TubeVault] Compiled Windows executables with custom icon:"
Write-Host "  - $hostExe"
Write-Host "  - $trayExe (System Tray + Web UI launcher)"
