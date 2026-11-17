import UIKit
import Capacitor
import AVFoundation
import WebKit

// Activate the app's playback session when the listener starts music, after
// WebKit has initialized its audio graph. Never activate merely on app launch.
private final class AudioSessionHandler: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == NodeServer.port,
              message.body as? String == "activate" else {
            replyHandler(nil, "Audio activation is only available to Slopify.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            replyHandler(true, nil)
        } catch {
            replyHandler(nil, "iOS could not activate the audio session.")
        }
    }
}

private final class FeedbackHandler: NSObject, WKScriptMessageHandler {
    private let selection = UISelectionFeedbackGenerator()
    private let impact = UIImpactFeedbackGenerator(style: .light)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == NodeServer.port,
              let kind = message.body as? String else { return }
        if kind == "selection" { selection.selectionChanged() }
        else if kind == "light" { impact.impactOccurred() }
    }
}

private final class ServerStatusHandler: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.scheme == "capacitor", url.host == "localhost",
              message.body as? String == "status" else {
            replyHandler(nil, "Server startup is only available to Slopify.")
            return
        }
        NodeServer.status { replyHandler($0, nil) }
    }
}

private final class PlaylistLinkHandler: NSObject, WKScriptMessageHandler {
    weak var controller: SlopifyViewController?
    init(_ controller: SlopifyViewController) { self.controller = controller }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        controller?.playlistListenerReady(message)
    }
}

final class SlopifyViewController: CAPBridgeViewController {
    private var pendingPlaylist: String?

    override func viewDidLoad() {
        // Capacitor's viewDidLoad starts navigation; wait until WebKit has our launch cookie first.
        guard let webView else { super.viewDidLoad(); return }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(NodeServer.sessionCookie) { [weak self] in
            self?.loadAuthenticatedView()
        }
    }

    private func loadAuthenticatedView() { super.viewDidLoad() }

    func openPlaylist(_ url: URL) {
        guard url.scheme == "slopify", url.host == "p", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil,
              url.path.utf8.count == 17,
              url.path.range(of: "^/[a-z0-9]{16}$", options: .regularExpression) != nil else { return }
        pendingPlaylist = String(url.path.dropFirst())
        deliverPlaylist()
    }

    private func deliverPlaylist() {
        guard let id = pendingPlaylist, let webView,
              let url = webView.url, url.scheme == "http", url.host == "127.0.0.1", url.port == NodeServer.port else { return }
        // The web listener acknowledges readiness after registering. Keep cold-start links until then.
        webView.evaluateJavaScript("window.slopifyNativeLinksReady === true && (window.dispatchEvent(new CustomEvent('slopifySharedLink', { detail: { type: 'shared', id: '\(id)' } })), true)") { [weak self] delivered, _ in
            if delivered as? Bool == true, self?.pendingPlaylist == id { self?.pendingPlaylist = nil }
        }
    }

    fileprivate func playlistListenerReady(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == NodeServer.port,
              message.body as? String == "ready" else { return }
        deliverPlaylist()
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        allowFullFrameRate(configuration.preferences)
        return configuration
    }

    /// ProMotion iPhones draw at 120 frames a second, but WebKit holds a page's rendering to about 60 ("Prefer Page
    /// Rendering Updates near 60fps", one of Safari's feature flags), so every animation looked half as smooth as
    /// the rest of the phone. It's turned off through WebKit's feature-flag interface where that exists; on a
    /// WebKit without it nothing changes. (Info.plist's CADisableMinimumFrameDurationOnPhone lets the app use 120.)
    /// It's private WebKit API, which the App Store would refuse; Slopify isn't distributed there, so every build has it.
    private func allowFullFrameRate(_ preferences: WKPreferences) {
        let listFeatures = NSSelectorFromString("_features")
        let setFeature = NSSelectorFromString("_setEnabled:forFeature:")
        let keySelector = NSSelectorFromString("key")
        guard WKPreferences.responds(to: listFeatures), preferences.responds(to: setFeature),
              let features = WKPreferences.perform(listFeatures)?.takeUnretainedValue() as? [NSObject] else { return }
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let setEnabled = unsafeBitCast(preferences.method(for: setFeature), to: SetEnabled.self)
        var found = false
        for feature in features where feature.responds(to: keySelector) {
            if (feature.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" {
                setEnabled(preferences, setFeature, false, feature)
                found = true
            }
        }
        #if DEBUG
        if !found { print("Slopify: WebKit's 60fps preference wasn't found; pages render at WebKit's default rate.") }
        #endif
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Capacitor replaces the configuration's content controller while
        // preparing its web view. Register on the final controller before load.
        webView?.configuration.userContentController.addScriptMessageHandler(AudioSessionHandler(), contentWorld: .page, name: "slopifyAudio")
        webView?.configuration.userContentController.add(FeedbackHandler(), name: "slopifyFeedback")
        webView?.configuration.userContentController.addScriptMessageHandler(ServerStatusHandler(), contentWorld: .page, name: "slopifyServer")
        webView?.configuration.userContentController.add(PlaylistLinkHandler(self), name: "slopifyLinks")
        // The page never rubber-bands past its edges; the app's own scrollers decide how they scroll.
        webView?.scrollView.bounces = false
        webView?.scrollView.alwaysBounceVertical = false
        // iOS 26 shades the scroll view's edges under the status bar and home indicator; the page draws its own
        // colours there (its top bar and navigation), so the system band would not match them.
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
            webView?.scrollView.bottomEdgeEffect.isHidden = true
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        let controller = SlopifyViewController()
        for context in connectionOptions.urlContexts { controller.openPlaylist(context.url) }
        window?.rootViewController = controller
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { (window?.rootViewController as? SlopifyViewController)?.openPlaylist(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
