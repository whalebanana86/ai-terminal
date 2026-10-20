// 주어진 PID 의 화면에 보이는 주 창 번호를 출력한다. screencapture -l 에 쓴다.
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
// 화면에 떠 있고 제목이 있는 창을 먼저, 없으면 가장 큰 창
let onscreen = mine.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
let pick = onscreen.max { area($0) < area($1) } ?? mine.max { area($0) < area($1) }
func area(_ w: [String: Any]) -> Double {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return (b["Width"] as? Double ?? 0) * (b["Height"] as? Double ?? 0)
}
if let w = pick { print(w[kCGWindowNumber as String]!) } else { exit(1) }
