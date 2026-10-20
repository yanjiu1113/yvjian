$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$tc = "C:\Users\sduser\Desktop\llm-chat-apk\.toolchain"
$sdk = "$tc\android-sdk"
$env:JAVA_HOME = "$tc\jdk-17"
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$sdkm = "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"

$yes = ($sdk + "\yes.txt")
$lines = (1..200 | ForEach-Object { "y" }) -join "`r`n"
[System.IO.File]::WriteAllText($yes, $lines + "`r`n")

Write-Host "=== accepting licenses ==="
cmd /c "`"$sdkm`" --sdk_root=`"$sdk`" --licenses < `"$yes`""
Write-Host "=== installing packages ==="
cmd /c "`"$sdkm`" --sdk_root=`"$sdk`" `"platform-tools`" `"platforms;android-34`" `"build-tools;34.0.0`" < `"$yes`""
Write-Host "=== installed ==="
cmd /c "`"$sdkm`" --sdk_root=`"$sdk`" --list_installed"
Remove-Item $yes -Force
