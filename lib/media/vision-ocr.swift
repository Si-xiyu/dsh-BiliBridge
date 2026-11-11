// 用 macOS 自带的 Vision 框架（VNRecognizeTextRequest）识别图片，结果写成 JSON 文件。
//
// 与 win-ocr.ps1 的接口保持一致，调用方不用区分平台：
//   单张：bili-ocr-vision -Path <图片> -Out <json> [-Language zh-Hans]
//   批量：bili-ocr-vision -Dir <目录> -Out <json> [-Language zh-Hans]
//
// 为什么也写文件而不走 stdout：两边统一，且不受终端编码影响。
//
// 输出：{ "language": "zh-Hans", "results": [ { "file": "...", "width": 1280, "height": 236, "lines": ["..."] } ] }
//
// 只返回整行文本，不返回坐标：时间轴由调用方的采样点决定（和 Windows 版同样的取舍）。

import Foundation
import ImageIO
import Vision

let stderrHandle = FileHandle.standardError

func fail(_ message: String) -> Never {
    stderrHandle.write(Data(("error: " + message + "\n").utf8))
    exit(1)
}

var singlePath: String?
var directory: String?
var outPath: String?
var requestedLanguage = "zh-Hans"

var index = 1
let arguments = CommandLine.arguments
while index < arguments.count {
    let key = arguments[index]
    guard index + 1 < arguments.count else { fail("参数 \(key) 缺少取值") }
    let value = arguments[index + 1]
    switch key {
    case "-Path": singlePath = value
    case "-Dir": directory = value
    case "-Out": outPath = value
    case "-Language": requestedLanguage = value
    default: fail("未知参数 \(key)")
    }
    index += 2
}

guard let out = outPath, !out.isEmpty else { fail("缺少 -Out") }
guard singlePath != nil || directory != nil else { fail("需要 -Path 或 -Dir") }

// 挑一个真正受支持的语言，避免把不支持的语言标签直接塞进去。
let supported = (try? VNRecognizeTextRequest.supportedRecognitionLanguages(
    for: .accurate,
    revision: VNRecognizeTextRequestRevision3
)) ?? []

func resolveLanguage(_ requested: String) -> String {
    if supported.contains(requested) { return requested }
    let lowered = requested.lowercased()
    if let match = supported.first(where: { $0.lowercased() == lowered }) { return match }
    if let prefix = supported.first(where: { $0.lowercased().hasPrefix(lowered) }) { return prefix }
    if supported.contains("zh-Hans") { return "zh-Hans" }
    if supported.contains("en-US") { return "en-US" }
    return supported.first ?? requested
}

let language = resolveLanguage(requestedLanguage)

var files: [String] = []
if let singlePath {
    let url = URL(fileURLWithPath: singlePath)
    guard FileManager.default.fileExists(atPath: url.path) else { fail("文件不存在：\(singlePath)") }
    files.append(url.path)
}
if let directory {
    let contents = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
    let jpgs = contents
        .filter { $0.lowercased().hasSuffix(".jpg") || $0.lowercased().hasSuffix(".jpeg") }
        .sorted()
        .map { (directory as NSString).appendingPathComponent($0) }
    files.append(contentsOf: jpgs)
}

if files.isEmpty { fail("没有可识别的图片") }

var results: [[String: Any]] = []
for file in files {
    let url = URL(fileURLWithPath: file)
    var width = 0
    var height = 0
    if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
       let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
        width = (properties[kCGImagePropertyPixelWidth] as? Int) ?? 0
        height = (properties[kCGImagePropertyPixelHeight] as? Int) ?? 0
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = [language]

    do {
        let handler = VNImageRequestHandler(url: url, options: [:])
        try handler.perform([request])
    } catch {
        fail("识别失败 \(url.lastPathComponent)：\(error.localizedDescription)")
    }

    let lines = (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .filter { !$0.isEmpty }

    results.append([
        "file": url.lastPathComponent,
        "width": width,
        "height": height,
        "lines": lines,
    ])
}

let payload: [String: Any] = ["language": language, "results": results]
guard JSONSerialization.isValidJSONObject(payload),
      let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
    fail("无法序列化识别结果")
}

do {
    try data.write(to: URL(fileURLWithPath: out), options: .atomic)
} catch {
    fail("写结果失败：\(error.localizedDescription)")
}
