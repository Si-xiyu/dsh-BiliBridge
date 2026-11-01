# 用 Windows 自带的 OCR（Windows.Media.Ocr）识别图片，结果写成 JSON 文件。
#
# 单张：
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-ocr.ps1 -Path <图片> -Out <json> [-Language zh-Hans]
# 批量（目录下所有 *.jpg，按文件名排序）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-ocr.ps1 -Dir <目录> -Out <json> [-Language zh-Hans]
#
# 为什么不用控制台输出：Windows PowerShell 5.1 的 stdout 是本地代码页，中文会乱码；
# 写 UTF-8 文件再让 Node 读最稳。
#
# 输出：{ "language": "zh-Hans-CN", "results": [ { "file": "...", "width": 1920, "height": 236, "lines": ["..."] } ] }
#
# 注意：这里只返回“整行文本”，不返回坐标。WinRT 的 OcrWord.BoundingRect 在
# PowerShell 5.1 里经投影后会退化成 0，坐标不可信；时间轴由调用方的采样点决定。

param(
    [string]$Path,
    [string]$Dir,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Language = 'zh-Hans'
)

$ErrorActionPreference = 'Stop'

if (-not $Path -and -not $Dir) {
    throw "需要 -Path 或 -Dir"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

# PS 5.1 没有 await，用 System.WindowsRuntimeSystemExtensions 把 IAsyncOperation 转 Task。
$asTaskGeneric = $null
foreach ($method in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
    if ($method.Name -ne 'AsTask') { continue }
    $params = $method.GetParameters()
    if ($params.Count -ne 1) { continue }
    if ($params[0].ParameterType.Name -like 'IAsyncOperation*') {
        $asTaskGeneric = $method
        break
    }
}
if ($null -eq $asTaskGeneric) {
    throw "找不到 IAsyncOperation 的 AsTask 重载，无法等待 WinRT 异步调用"
}

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Language))
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
    throw "没有可用的 OCR 语言包（请求 $Language）；可在 Windows 设置里安装该语言的 OCR 组件"
}

$files = @()
if ($Path) {
    $files += (Resolve-Path -LiteralPath $Path).Path
}
if ($Dir) {
    $files += Get-ChildItem -LiteralPath $Dir -Filter *.jpg | Sort-Object Name | ForEach-Object { $_.FullName }
}

$results = @()
foreach ($filePath in $files) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($filePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $ocr.Lines) {
        if ($line.Text) { $lines += $line.Text }
    }

    $results += [pscustomobject]@{
        file   = [System.IO.Path]::GetFileName($filePath)
        width  = [int]$decoder.PixelWidth
        height = [int]$decoder.PixelHeight
        lines  = $lines
    }

    $stream.Dispose()
    $bitmap.Dispose()
}

$payload = [pscustomobject]@{
    language = $engine.RecognizerLanguage.LanguageTag
    results  = $results
}

$json = $payload | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
