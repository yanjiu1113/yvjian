# Build LLM Chat APK with the standalone Android SDK (aapt2 + javac + d8 + apksigner).
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$sdk = Join-Path $root ".toolchain\android-sdk"
$jdk = Join-Path $root ".toolchain\jdk-17"
$bt = Join-Path $sdk "build-tools\34.0.0"
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"
$src = Join-Path $root "app\src\main"
$out = Join-Path $root "build"
$dist = Join-Path $root "dist"

if (-not (Test-Path $androidJar)) { throw "Android SDK not found at $sdk" }

$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$out\classes", "$out\dex", $dist | Out-Null

function Run($exe, $cmdArgs) {
    cmd /c "`"$exe`" $cmdArgs"
    if ($LASTEXITCODE -ne 0) { throw "FAILED ($LASTEXITCODE): $exe" }
}

Write-Host "==> aapt2 compile"
Run "$bt\aapt2.exe" "compile --dir `"$src\res`" -o `"$out\res.zip`""

Write-Host "==> aapt2 link"
Run "$bt\aapt2.exe" "link -o `"$out\base.apk`" -I `"$androidJar`" --manifest `"$src\AndroidManifest.xml`" -R `"$out\res.zip`" -A `"$src\assets`" --min-sdk-version 26 --target-sdk-version 34 --version-code 74 --version-name 3.39 --no-version-vectors"

Write-Host "==> javac"
$files = Get-ChildItem (Join-Path $src "java") -Recurse -Filter *.java | ForEach-Object { $_.FullName.Replace('\', '/') }
$argFile = Join-Path $out "javac.args"
# javac @argfiles treat backslashes as escapes, so use forward slashes and no quotes.
$argLines = @("-encoding", "UTF-8", "--release", "11", "-classpath", $androidJar.Replace('\', '/'), "-d", ($out + '\classes').Replace('\', '/')) + $files
[System.IO.File]::WriteAllLines($argFile, [string[]]$argLines, [System.Text.Encoding]::ASCII)
Run "$jdk\bin\javac.exe" "@`"$argFile`""

Write-Host "==> jar"
# unique name: an antivirus / leftover handle can lock a fixed path between runs
$jarName = "classes-" + (Get-Date -Format "HHmmssfff") + ".jar"
$jarPath = Join-Path $out $jarName
Run "$jdk\bin\jar.exe" "cf `"$jarPath`" -C `"$out\classes`" ."

Write-Host "==> d8"
Run "$bt\d8.bat" "--release --min-api 26 --lib `"$androidJar`" --output `"$out\dex`" `"$jarPath`""

Write-Host "==> package dex"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open((Join-Path $out "base.apk"), 'Update')
$entry = $zip.GetEntry("classes.dex")
if ($entry) { $entry.Delete() }
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, (Join-Path $out "dex\classes.dex"), "classes.dex",
    [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
$zip.Dispose()

Write-Host "==> zipalign"
Run "$bt\zipalign.exe" "-f -p 4 `"$out\base.apk`" `"$out\aligned.apk`""

$ksDir = Join-Path $root "keystore"
$ks = Join-Path $ksDir "llmchat.jks"
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
    Write-Host "==> generating signing key"
    Run "$jdk\bin\keytool.exe" "-genkeypair -keystore `"$ks`" -alias llmchat -keyalg RSA -keysize 2048 -validity 36500 -storepass llmchat-local -keypass llmchat-local -dname `"CN=LLM Chat, OU=Local, O=Local, L=NA, ST=NA, C=CN`""
}

Write-Host "==> apksigner"
$apk = Join-Path $dist "Yujian-3.39.apk"
Run "$bt\apksigner.bat" "sign --ks `"$ks`" --ks-pass pass:llmchat-local --key-pass pass:llmchat-local --v1-signing-enabled true --v2-signing-enabled true --out `"$apk`" `"$out\aligned.apk`""

Write-Host "==> verify"
Run "$bt\apksigner.bat" "verify --verbose `"$apk`""

$info = Get-Item $apk
Write-Host ""
Write-Host ("APK: " + $info.FullName)
Write-Host ("size: " + [math]::Round($info.Length / 1KB, 1) + " KB")
