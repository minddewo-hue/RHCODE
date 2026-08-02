$env:ANDROID_HOME = 'D:\android_sdk'
$env:NODE_ENV = 'production'
$env:EXPO_PUBLIC_TRANSFER_SERVER_URL = 'http://218.201.210.211:8000'
Set-Location 'D:\work_space\RHZYCODE\mobile\android'
& .\gradlew.bat --init-script 'D:\work_space\RHZYCODE\appupdate\scripts\gradle-no-proxy.init.gradle' :app:createBundleReleaseJsAndAssets :app:assembleRelease --rerun-tasks
exit $LASTEXITCODE
