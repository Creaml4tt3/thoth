// macOS Vision baseline: VNRecognizeTextRequest, accurate, th-TH + en-US. One JSON line per image on stdout.
// Build: swiftc -O scripts/vision_ocr.swift -o target/vision_ocr ; run: target/vision_ocr <image>...
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
        continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["th-TH", "en-US"]
    req.usesLanguageCorrection = true
    let t = Date()
    try? VNImageRequestHandler(cgImage: cg).perform([req])
    let ms = Date().timeIntervalSince(t) * 1000
    // Top to bottom (Vision's y grows upward), then left to right within a row.
    let obs = (req.results ?? []).sorted {
        let a = ($0.boundingBox.midY * 100).rounded(), b = ($1.boundingBox.midY * 100).rounded()
        return a != b ? a > b : $0.boundingBox.minX < $1.boundingBox.minX
    }
    let text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let line: [String: Any] = ["id": path, "ms": ms, "text": text, "w": cg.width, "h": cg.height]
    let data = try! JSONSerialization.data(withJSONObject: line)
    print(String(data: data, encoding: .utf8)!)
}
