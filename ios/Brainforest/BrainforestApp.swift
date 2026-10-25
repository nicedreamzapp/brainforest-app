// Brainforest — self-contained kids' learning world (K-4).
// Native shell: WKWebView hosting the bundled web app, with four bridges:
//   bfStore  — persists the engine's JSON store to Documents/brainforest_store.json
//   bfTTS    — speaks via prerecorded voice pack (web/voice/) or AVSpeechSynthesizer
//   bfIAP    — StoreKit 2: "Brainforest Forever" one-time unlock after the 60-day trial
//   bf://    — custom scheme serving the bundled web/ folder (absolute paths work)

import SwiftUI
import UIKit
import WebKit
import AVFoundation
import CryptoKit
import StoreKit

@main
struct BrainforestApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        BrainWebView()
            .ignoresSafeArea()
            .background(Color(red: 0.98, green: 0.95, blue: 1.0))
            .statusBarHidden(true)
            .persistentSystemOverlays(.hidden)
    }
}

// MARK: - Store (persistent JSON)

enum BrainStore {
    static var fileURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("brainforest_store.json")
    }
    static func load() -> String? {
        try? String(contentsOf: fileURL, encoding: .utf8)
    }
    static func save(_ json: String) {
        try? json.data(using: .utf8)?.write(to: fileURL, options: .atomic)
    }
}

// MARK: - TTS (recorded voice pack first, synthesizer fallback)

final class Narrator: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    static let shared = Narrator()
    weak var webView: WKWebView?

    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private lazy var voice: AVSpeechSynthesisVoice? = Self.bestVoice()
    private lazy var manifest: [String: String] = Self.loadManifest()

    override init() {
        super.init()
        synth.delegate = self
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
    }

    static func bestVoice() -> AVSpeechSynthesisVoice? {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        let premium = en.first { $0.quality == .premium && $0.language == "en-US" }
        let enhanced = en.first { $0.quality == .enhanced && $0.language == "en-US" }
        return premium ?? enhanced ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    static func loadManifest() -> [String: String] {
        guard let url = Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "web/voice"),
              let data = try? Data(contentsOf: url),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { return [:] }
        return dict
    }

    static func normalize(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .lowercased()
    }

    private func recordedURL(for text: String) -> URL? {
        let key = Insecure.MD5.hash(data: Data(Self.normalize(text).utf8))
            .map { String(format: "%02x", $0) }.joined()
        guard let file = manifest[key] else { return nil }
        return Bundle.main.url(forResource: file, withExtension: nil, subdirectory: "web/voice")
    }

    // One serial queue for BOTH recorded clips and synth fallback, so lines
    // always play in order and never overlap regardless of source.
    private var speakQueue: [(id: Int, text: String)] = []
    private var currentID: Int?
    private var stopping = false

    func speak(id: Int, text: String, interrupt: Bool) {
        if interrupt { stopAll(notify: true) }
        speakQueue.append((id, text))
        pump()
    }

    private func pump() {
        guard currentID == nil, !speakQueue.isEmpty else { return }
        let item = speakQueue.removeFirst()
        currentID = item.id
        if let url = recordedURL(for: item.text), let p = try? AVAudioPlayer(contentsOf: url) {
            player = p
            p.delegate = self
            p.play()
        } else {
            let u = AVSpeechUtterance(string: item.text)
            u.voice = voice
            u.rate = 0.48
            u.pitchMultiplier = 1.05
            synth.speak(u)
        }
    }

    private func finishCurrent() {
        guard !stopping else { return }
        let id = currentID
        currentID = nil
        player = nil
        if let id { done(id) }
        pump()
    }

    func stopAll(notify: Bool) {
        stopping = true
        let pending = speakQueue.map(\.id)
        speakQueue.removeAll()
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        let cur = currentID
        currentID = nil
        stopping = false
        if notify {
            if let cur { done(cur) }
            pending.forEach(done)
        }
    }

    private func done(_ id: Int) {
        webView?.evaluateJavaScript("window.__bfTTS && window.__bfTTS.done(\(id))")
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finishCurrent() }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { finishCurrent() }
    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) { finishCurrent() }
}

// MARK: - bf:// scheme handler (serves the bundled web/ folder)

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let mime: [String: String] = [
        "html": "text/html", "js": "application/javascript", "css": "text/css",
        "json": "application/json", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "svg": "image/svg+xml", "wav": "audio/wav",
        "m4a": "audio/mp4", "mp3": "audio/mpeg", "woff2": "font/woff2",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if path == "/parent" { path = "/parent.html" }
        // Strip the legacy /static prefix so untouched asset URLs keep working.
        if path.hasPrefix("/static/") { path.removeFirst("/static".count) }
        let rel = String(path.dropFirst())
        guard let fileURL = Bundle.main.url(forResource: rel, withExtension: nil, subdirectory: "web"),
              let data = try? Data(contentsOf: fileURL) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let ext = (rel as NSString).pathExtension.lowercased()
        let headers = ["Content-Type": Self.mime[ext] ?? "application/octet-stream",
                       "Content-Length": String(data.count)]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Purchases (StoreKit 2 — "Brainforest Forever" one-time unlock)

final class Purchases {
    static let shared = Purchases()
    weak var webView: WKWebView?
    static let productID = "com.brainforest.app.forever"

    private var updatesTask: Task<Void, Never>?
    private var cachedProduct: Product?

    private func reply(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.__bfIAP && window.__bfIAP.result(\(json))")
        }
    }

    private func owned() async -> Bool {
        for await entitlement in Transaction.currentEntitlements {
            if case .verified(let t) = entitlement, t.productID == Self.productID { return true }
        }
        return false
    }

    // StoreKit requires a transaction listener that runs for the whole life of the
    // app. Without it, a purchase that completes out-of-band (Ask to Buy, an
    // interrupted sheet, a re-auth prompt) never gets finished and the unlock is
    // silently lost. Started once, at launch, before any paywall can appear.
    func startListening() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) {
            for await update in Transaction.updates {
                guard case .verified(let t) = update else { continue }
                await t.finish()
                if t.productID == Self.productID {
                    Purchases.shared.reply(["cmd": "buy", "ok": true])
                }
            }
        }
    }

    // A single products(for:) call can come back empty on a cold or flaky
    // network — StoreKit does not retry for you. Retry a few times before
    // telling the caller the product doesn't exist.
    private func product() async throws -> Product? {
        if let cachedProduct { return cachedProduct }
        var lastError: Error?
        for attempt in 0..<3 {
            do {
                if let p = try await Product.products(for: [Self.productID]).first {
                    cachedProduct = p
                    return p
                }
            } catch {
                lastError = error
            }
            if attempt < 2 { try? await Task.sleep(nanoseconds: 800_000_000) }
        }
        if let lastError { throw lastError }
        return nil
    }

    @MainActor
    private static func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    func handle(cmd: String) {
        Task {
            switch cmd {
            case "status":
                let isOwned = await owned()
                var price = "$0.99"
                var loaded = false
                if let p = try? await product() {
                    price = p.displayPrice
                    loaded = true
                }
                reply(["cmd": "status", "owned": isOwned, "price": price, "loaded": loaded])
            case "buy":
                do {
                    guard let product = try await product() else {
                        reply(["cmd": "buy", "ok": false, "error": "not-found"]); return
                    }
                    // Present the payment sheet in an explicit scene. The
                    // no-argument purchase() has to guess which scene is
                    // frontmost, and in a WKWebView-driven app it can guess
                    // wrong and never show the sheet at all.
                    let result: Product.PurchaseResult
                    if let scene = await Self.activeScene() {
                        result = try await product.purchase(confirmIn: scene)
                    } else {
                        result = try await product.purchase()
                    }
                    switch result {
                    case .success(let verification):
                        if case .verified(let t) = verification {
                            await t.finish()
                            reply(["cmd": "buy", "ok": true])
                        } else {
                            reply(["cmd": "buy", "ok": false, "error": "unverified"])
                        }
                    case .userCancelled:
                        reply(["cmd": "buy", "ok": false, "error": "cancelled"])
                    case .pending:
                        // Ask to Buy / SCA — the transaction listener above will
                        // deliver the unlock when the parent approves it.
                        reply(["cmd": "buy", "ok": false, "error": "pending"])
                    @unknown default:
                        reply(["cmd": "buy", "ok": false, "error": "unknown"])
                    }
                } catch {
                    // Carry the real StoreKit error through to the UI. Silently
                    // collapsing every failure into "failed" is what made the
                    // last App Review rejection impossible to diagnose.
                    reply(["cmd": "buy", "ok": false, "error": "failed",
                           "detail": String(describing: error)])
                }
            case "restore":
                try? await AppStore.sync()
                let isOwned = await owned()
                reply(["cmd": "restore", "ok": true, "owned": isOwned])
            default: break
            }
        }
    }
}

// MARK: - Bridges

final class BridgeHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "bfStore":
            if let json = message.body as? String { BrainStore.save(json) }
        case "bfIAP":
            if let dict = message.body as? [String: Any], let cmd = dict["cmd"] as? String {
                Purchases.shared.handle(cmd: cmd)
            }
        case "bfTTS":
            guard let dict = message.body as? [String: Any],
                  let cmd = dict["cmd"] as? String else { return }
            if cmd == "speak" {
                Narrator.shared.speak(
                    id: dict["id"] as? Int ?? 0,
                    text: dict["text"] as? String ?? "",
                    interrupt: dict["interrupt"] as? Bool ?? false)
            } else if cmd == "stop" {
                Narrator.shared.stopAll(notify: true)
            }
        default: break
        }
    }
}

// MARK: - WebView

struct BrainWebView: UIViewRepresentable {
    final class Coordinator: NSObject, WKNavigationDelegate {
        // If iOS kills the web process (memory pressure, WebKit crash), the kid
        // would see a frozen white screen. Reload instead — store is persisted,
        // so she lands back on the picker with everything intact.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "bf")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let ucc = WKUserContentController()
        let bridge = BridgeHandler()
        ucc.add(bridge, name: "bfStore")
        ucc.add(bridge, name: "bfTTS")
        ucc.add(bridge, name: "bfIAP")
        #if DEBUG
        // Force the trial-expired lock screen for testing (BF_TRIAL_EXPIRED=1 via simctl)
        if ProcessInfo.processInfo.environment["BF_TRIAL_EXPIRED"] != nil {
            let step = ProcessInfo.processInfo.environment["BF_GATE_STEP"] ?? ""
            ucc.addUserScript(WKUserScript(source: "window.__BF_TRIAL_EXPIRED = 1; window.__BF_GATE_STEP = \"\(step)\";",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        #endif
        if let saved = BrainStore.load() {
            // Inject the persisted store before any script runs.
            let script = "window.__BF_STORE = \(saved);"
            ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        #if DEBUG
        // UI tour for automated screenshot sweeps (BF_UITOUR=1 via simctl).
        if ProcessInfo.processInfo.environment["BF_UITOUR"] != nil {
            let noBadge = ProcessInfo.processInfo.environment["BF_NOBADGE"] != nil ? "window.__BF_NOBADGE = 1;" : ""
            ucc.addUserScript(WKUserScript(source: "window.__BF_UITOUR = 1; \(noBadge) window.__BF_STORE = {kids:{},kv:{}};",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        #endif
        config.userContentController = ucc

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        Narrator.shared.webView = webView
        Purchases.shared.webView = webView
        Purchases.shared.startListening()
        webView.load(URLRequest(url: URL(string: "bf://app/index.html")!))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
