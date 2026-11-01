# 探测本机可用的「系统自带」语音识别引擎，判断 ASR 能不能也零安装。
# 只读，不安装任何东西。
$ErrorActionPreference = 'Continue'

try {
    Add-Type -AssemblyName System.Speech -ErrorAction Stop
    $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    if (-not $recognizers -or $recognizers.Count -eq 0) {
        "SAPI: (no recognizers installed)"
    } else {
        "SAPI recognizers:"
        foreach ($r in $recognizers) {
            "  - $($r.Culture.Name) | $($r.Name) | id=$($r.Id)"
        }
    }
} catch {
    "SAPI probe failed: $($_.Exception.Message)"
}
