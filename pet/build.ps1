# Build ��Ȥ�� APK with the standalone Android SDK (aapt2 + javac + d8 + apksigner).
# ���������òֿ��Ŀ¼�� .toolchain��pet/ ������ֿ����Ŀ¼����
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
# aapt2 不认非 ASCII 路径（中文目录会报 failed to open directory），
# 所以检测到中文路径就临时建软链接，用 ASCII 路径把同一个脚本再跑一遍。
if ($root -match "[^\x00-\x7F]" -and -not $env:YJPET_ASCII_MIRROR) {
    $stage = Join-Path $env:TEMP ("yjpet_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $parent = Split-Path $root -Parent
    cmd /c "mklink /J `"$stage\pet`" `"$root`"" | Out-Null
    foreach ($sib in @(".toolchain", "keystore")) {
        if (Test-Path (Join-Path $parent $sib)) {
            cmd /c "mklink /J `"$stage\$sib`" `"$(Join-Path $parent $sib)`"" | Out-Null
        }
    }
    Write-Host "==> path has non-ASCII chars, mirroring to $stage"
    $env:YJPET_ASCII_MIRROR = "1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stage "pet\build.ps1")
    $code = $LASTEXITCODE
    $newest = Get-ChildItem (Join-Path $root "dist") -Filter "*.apk" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { Write-Host "==> APK: $($newest.FullName)" }
    foreach ($sib in @("pet", ".toolchain", "keystore")) {
        $p2 = Join-Path $stage $sib
        if (Test-Path $p2) { cmd /c "rmdir `"$p2`"" 2>$null | Out-Null }
    }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    exit $code
}
$toolchain = Join-Path (Split-Path $root -Parent) ".toolchain"
$sdk = Join-Path $toolchain "android-sdk"
$jdk = Join-Path $toolchain "jdk-17"
$bt = Join-Path $sdk "build-tools\34.0.0"
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"
$src = Join-Path $root "app\src\main"
$out = Join-Path $root "build"
$dist = Join-Path $root "dist"

$versionCode = "104"
$versionName = "0.104"
$apkName = "YujianPet-$versionName.apk"

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
Run "$bt\aapt2.exe" "link -o `"$out\base.apk`" -I `"$androidJar`" --manifest `"$src\AndroidManifest.xml`" -R `"$out\res.zip`" -A `"$src\assets`" --min-sdk-version 26 --target-sdk-version 34 --version-code $versionCode --version-name $versionName --no-version-vectors"

Write-Host "==> javac"
$files = Get-ChildItem (Join-Path $src "java") -Recurse -Filter *.java | ForEach-Object { $_.FullName.Replace('\', '/') }
$argFile = Join-Path $out "javac.args"
$argLines = @("-encoding", "UTF-8", "--release", "11", "-classpath", $androidJar.Replace('\', '/'), "-d", ($out + '\classes').Replace('\', '/')) + $files
[System.IO.File]::WriteAllLines($argFile, [string[]]$argLines, [System.Text.Encoding]::ASCII)
Run "$jdk\bin\javac.exe" "@`"$argFile`""

Write-Host "==> jar"
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

# ������˹���ǩ���������Ժ��� signature ��Ȩ�����㲥У��
$chatKs = Join-Path (Split-Path $root -Parent) "keystore\llmchat.jks"
$ks = Join-Path $root "keystore\yujianpet.jks"
if (-not (Test-Path $ks)) {
    if (Test-Path $chatKs) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root "keystore") | Out-Null
        Copy-Item $chatKs $ks
        Write-Host "==> reusing chat keystore"
    } else {
        New-Item -ItemType Directory -Force -Path (Join-Path $root "keystore") | Out-Null
        Write-Host "==> generating signing key"
        Run "$jdk\bin\keytool.exe" "-genkeypair -keystore `"$ks`" -alias llmchat -keyalg RSA -keysize 2048 -validity 36500 -storepass llmchat-local -keypass llmchat-local -dname `"CN=Yujian Pet, OU=Local, O=Local, L=NA, ST=NA, C=CN`""
    }
}

Write-Host "==> apksigner"
$apk = Join-Path $dist $apkName
Run "$bt\apksigner.bat" "sign --ks `"$ks`" --ks-pass pass:llmchat-local --key-pass pass:llmchat-local --v1-signing-enabled true --v2-signing-enabled true --out `"$apk`" `"$out\aligned.apk`""

Write-Host "==> verify"
Run "$bt\apksigner.bat" "verify --verbose `"$apk`""

$info = Get-Item $apk
Write-Host ""
Write-Host ("APK: " + $info.FullName)
Write-Host ("size: " + [math]::Round($info.Length / 1KB, 1) + " KB")
