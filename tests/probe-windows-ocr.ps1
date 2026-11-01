# 探测 Windows 自带 OCR（Windows.Media.Ocr）是否可用、支持哪些语言。
# 只读，不安装任何东西。
$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
} catch {
    "Add-Type failed: $($_.Exception.Message)"
    exit 2
}

try {
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
} catch {
    "WinRT type load failed: $($_.Exception.Message)"
    exit 3
}

$engine = [Windows.Media.Ocr.OcrEngine]
"MaxImageDimension=$($engine::MaxImageDimension)"

$langs = $engine::AvailableRecognizerLanguages
if (-not $langs -or $langs.Count -eq 0) {
    "AvailableRecognizerLanguages: (empty)"
    exit 4
}

"AvailableRecognizerLanguages:"
$langs | ForEach-Object { "  - $($_.LanguageTag)  native=$($_.NativeName)" }

$zh = $engine::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans'))
"TryCreateFromLanguage(zh-Hans): $([bool]$zh)"
if (-not $zh) {
    $auto = $engine::TryCreateFromUserProfileLanguages()
    "TryCreateFromUserProfileLanguages: $([bool]$auto)"
}
