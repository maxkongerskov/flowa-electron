// flowa-helper — tiny macOS companion for Flowa-Electron.
//
// Gives the Electron app the exact macOS primitives the Swift app used:
//   watch-fn     CGEventTap (listen-only, flagsChanged) → prints fn-down / fn-up
//                (GlobalHotkey.swift). Prints "ready" or "denied" first.
//   check-im     IOHIDCheckAccess(ListenEvent) → granted | denied   (PermissionChecker.swift)
//   request-im   IOHIDRequestAccess(ListenEvent)
//   frontmost    NSWorkspace.frontmostApplication → {"pid","bundleId","name"}
//   paste [pid]  activate pid, wait 0.12 s, post ⌘V via CGEvent (TextInserter.swift)
//
// Build: npm run setup:mac-helper  (swiftc -O, universal arm64+x86_64)

import AppKit
import ApplicationServices
import Foundation
import IOKit.hid

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments.dropFirst()

func emit(_ s: String) { print(s); fflush(stdout) }

// Globals (not locals) so the C event-tap callback can use them without capturing.
var fnDown = false
final class TapBox { var tap: CFMachPort? }
let tapBox = TapBox()

switch args.first ?? "" {
case "watch-fn":
    // Exit when the parent closes our stdin (Electron quit / crash).
    Thread.detachNewThread {
        while let _ = readLine(strippingNewline: true) {}
        exit(0)
    }
    // macOS will happily create a listen-only tap without Input Monitoring, but it
    // never delivers events — and keeps delivering nothing even after the user grants
    // access. Report "denied" instead so the app can prompt and retry after the grant.
    guard CGPreflightListenEventAccess(),
          IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted else {
        emit("denied")
        exit(3)
    }
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tapBox.tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let now = event.flags.contains(.maskSecondaryFn)
        DispatchQueue.main.async {
            if now && !fnDown { fnDown = true; emit("fn-down") }
            else if !now && fnDown { fnDown = false; emit("fn-up") }
        }
        return Unmanaged.passUnretained(event)
    }
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: callback,
        userInfo: nil
    ) else {
        emit("denied")
        exit(3)
    }
    tapBox.tap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit("ready")
    CFRunLoopRun()

case "check-im":
    emit(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted ? "granted" : "denied")

case "request-im":
    emit(IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) ? "granted" : "denied")

case "frontmost":
    guard let app = NSWorkspace.shared.frontmostApplication else { exit(1) }
    let obj: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "bundleId": app.bundleIdentifier ?? NSNull(),
        "name": app.localizedName ?? NSNull()
    ]
    let data = try! JSONSerialization.data(withJSONObject: obj)
    emit(String(data: data, encoding: .utf8)!)

case "check-ax":
    emit(AXIsProcessTrusted() ? "granted" : "denied")

case "paste":
    // TextInserter.swift: activate the captured target, settle 0.12 s, post ⌘V.
    // Extra safety vs Swift: macOS 14+ "cooperative activation" lets a background
    // process's activate() silently fail, so ⌘V would land in whatever app is in
    // front. We only post ⌘V once the target really is frontmost.
    guard AXIsProcessTrusted() else { emit("accessibility-missing"); exit(4) }
    func frontPid() -> pid_t? {
        // Spin the run loop briefly so NSWorkspace's cached frontmost app is fresh.
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    if let pidArg = args.dropFirst().first, let pid = Int32(pidArg) {
        guard let target = NSRunningApplication(processIdentifier: pid), !target.isTerminated else {
            emit("target-gone"); exit(5)
        }
        if frontPid() != pid {
            target.unhide()
            _ = target.activate(options: [.activateAllWindows])
            let deadline = Date().addingTimeInterval(1.0)
            while frontPid() != pid && Date() < deadline {}
        }
        guard frontPid() == pid else {
            let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
            emit("not-frontmost target=\(target.localizedName ?? "?") front=\(front)")
            exit(5)
        }
    }
    Thread.sleep(forTimeInterval: 0.12)
    let src = CGEventSource(stateID: .combinedSessionState)
    let cmdKey: CGKeyCode = 0x37, vKey: CGKeyCode = 0x09
    guard
        let cmdDown = CGEvent(keyboardEventSource: src, virtualKey: cmdKey, keyDown: true),
        let vDown = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true),
        let vUp = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false),
        let cmdUp = CGEvent(keyboardEventSource: src, virtualKey: cmdKey, keyDown: false)
    else { emit("event-create-failed"); exit(1) }
    cmdDown.flags = .maskCommand
    vDown.flags = .maskCommand
    vUp.flags = .maskCommand
    cmdDown.post(tap: .cgSessionEventTap)
    vDown.post(tap: .cgSessionEventTap)
    vUp.post(tap: .cgSessionEventTap)
    cmdUp.post(tap: .cgSessionEventTap)
    // Let the window server take the events before this short-lived process exits.
    Thread.sleep(forTimeInterval: 0.05)
    emit("pasted front=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")")

default:
    FileHandle.standardError.write("usage: flowa-helper watch-fn|check-im|request-im|check-ax|frontmost|paste [pid]\n".data(using: .utf8)!)
    exit(64)
}
