# 用 Windows 自带的 SAPI（System.Speech）转写一个 16k 单声道 wav，结果写 JSON。
# 零安装，但用的是桌面端老引擎，质量仅供评估。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sapi-asr.ps1 -Wave <wav> -Out <json> [-Culture zh-CN] [-MaxSeconds 120]

param(
    [Parameter(Mandatory = $true)][string]$Wave,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Culture = 'zh-CN',
    [int]$MaxSeconds = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech

$cultureInfo = New-Object System.Globalization.CultureInfo($Culture)
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($cultureInfo)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($Wave)

$results = @()
$deadline = if ($MaxSeconds -gt 0) { (Get-Date).AddSeconds($MaxSeconds) } else { [datetime]::MaxValue }

while ((Get-Date) -lt $deadline) {
    $recognized = $engine.Recognize()
    if ($null -eq $recognized) { break }
    $text = $recognized.Text
    if (-not $text) { continue }
    $audio = $recognized.Audio
    $results += [pscustomobject]@{
        text     = $text
        startSec = [math]::Round($audio.StartTime.TotalSeconds, 2)
        durSec   = [math]::Round($audio.Duration.TotalSeconds, 2)
    }
}

$engine.Dispose()

$payload = [pscustomobject]@{
    culture = $cultureInfo.Name
    count   = $results.Count
    results = $results
}

[System.IO.File]::WriteAllText($Out, ($payload | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
