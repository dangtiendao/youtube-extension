$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $rootDir "installer"
$stagingDir = Join-Path $installerDir "staging"

# Clean staging
if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "runtime") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "app") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "app\web-ui") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "extension") | Out-Null

# 1. Copy official signed node.exe
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe (Join-Path $stagingDir "runtime\node.exe")

# 2. Copy bundled engine.cjs, launchers & Web UI
Copy-Item (Join-Path $rootDir "packages\engine\dist\engine.cjs") (Join-Path $stagingDir "app\engine.cjs")
Copy-Item (Join-Path $installerDir "bin\ytdl-host.exe") (Join-Path $stagingDir "app\ytdl-host.exe")
Copy-Item (Join-Path $installerDir "bin\TubeVault.exe") (Join-Path $stagingDir "app\TubeVault.exe")
Copy-Item -Recurse (Join-Path $rootDir "packages\extension\dist-web\*") (Join-Path $stagingDir "app\web-ui\")

# 3. Copy built Chrome Extension (with fixed RSA key in manifest.json)
Copy-Item -Recurse (Join-Path $rootDir "packages\extension\dist-ext\*") (Join-Path $stagingDir "extension\")

# 4. Copy install guide
Copy-Item (Join-Path $installerDir "install-guide.html") (Join-Path $stagingDir "install-guide.html")

# 5. Resolve Fixed Extension ID and render generated setup.iss
$keyMeta = Get-Content (Join-Path $rootDir "packages\extension\extension-key.public.json") -Raw | ConvertFrom-Json
$extId = $keyMeta.extensionId
$issTemplate = Get-Content (Join-Path $installerDir "setup.iss") -Raw
$issRendered = $issTemplate.Replace("#EXT_ID_PLACEHOLDER#", $extId)
$issTempPath = Join-Path $installerDir "setup.generated.iss"
Set-Content -Path $issTempPath -Value $issRendered -Encoding UTF8

Write-Host "[TubeVault] Staging folder prepared at: $stagingDir"
Write-Host "[TubeVault] Fixed Extension ID embedded: $extId"

# 6. Locate Inno Setup Compiler (ISCC.exe)
$isccCandidates = @(
    (Get-Command iscc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$iscc = $isccCandidates | Select-Object -First 1

if (-not $iscc) {
    Write-Warning "Inno Setup 6 (ISCC.exe) is not installed yet."
    Write-Host "All installer files are staged cleanly in: $stagingDir"
    Write-Host "To compile TubeVault-Setup-1.0.0.exe, install Inno Setup 6:"
    Write-Host "  winget install JRSoftware.InnoSetup"
    Write-Host "Then run: npm run build:installer"
    exit 0
}

Write-Host "[TubeVault] Compiling Setup.exe with Inno Setup: $iscc"
& $iscc $issTempPath
if ($LASTEXITCODE -ne 0) { throw "ISCC compilation failed" }

Write-Host "[TubeVault] Installer built successfully in: $(Join-Path $installerDir 'output')"
