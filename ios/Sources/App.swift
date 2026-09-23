import UIKit
import WebKit
import QuartzCore

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

/// Sees every touch before the app does (without taking part in it), so the web view can be kept rendering at
/// 120Hz while a finger is on the screen and for a moment after (scroll momentum).
final class TouchWindow: UIWindow {
    static var onTouch: (() -> Void)?
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches { TouchWindow.onTouch?() }
        super.sendEvent(event)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = TouchWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

/// Snapchat Web in a full-screen WKWebView with the Dark Mobile scripts built in.
///
/// - hooks.js (presence, snap-clean, gifs-find) runs in the page's own world at document start. WKUserScript
///   injection isn't subject to Snapchat's CSP, so it always lands before Snapchat's bundle.
/// - ui.js (theme, GIF picker/display, gif-anim) runs in a private content world with gm-shim.js, which
///   backs the GM.* calls with the "dg" message handler below (settings in UserDefaults, Giphy downloads).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, UIScrollViewDelegate {
    private static let home = URL(string: "https://www.snapchat.com/web")!
    // Logged out, Snapchat shows "Download Snapchat" instead of the login form when the page is narrower
    // than ~700px, and WKWebView has no "Request Desktop Website" (Safari's private wide-layout setting;
    // a width=980 viewport tag was ignored too). So outside Snapchat Web itself the web view is
    // loginWidth points wide and scaled down to fit; on /web it's the phone's real width. The Mac user
    // agent and compat.js keep Snapchat treating it as a desktop browser.
    private static let loginWidth: CGFloat = 820
    /// Snapchat Web's own sizes are a bit big on a phone; lay it out this much wider and scale it down
    /// (textscale.js then makes the text itself bigger again).
    private static let appScale: CGFloat = 0.8
    private static let tabBarColor = UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
    private static let tabBarHeight: CGFloat = 82
    private static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
    private static let giphyHosts: Set<String> = ["media.giphy.com", "api.giphy.com"]
    private static let background = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)

    private let world = WKContentWorld.world(name: "darkmobile")
    private var webView: WKWebView!
    // starts true because the app opens /web: laying the page out at the login width first and then
    // switching once the URL arrived sometimes left Snapchat's grid at a stale height, which also kept
    // glass.js from switching to the single-pane layout (desktop two-pane view, list cut off)
    private var inApp = true
    private var chatOpen = false
    private var storiesOpen = false
    private var cameraOpen = false
    private var previewOpen = false // taken-snap screen: Snapchat's own back button sits where our close-camera X is
    private let closeStoriesButton = UIButton(type: .system)
    private let tabBar = UIView()
    private weak var storiesButton: UIButton?
    private var urlObservation: NSKeyValueObservation?
    private var urlLog: [String] = []
    private var healed = false
    private var loaded = false
    private var lastShowBar: Bool?
    private var keyboardOverlap: CGFloat = 0
    // smoothness: 120Hz while touching, and a picture of the last chat list shown at launch
    private var displayLink: CADisplayLink?
    private var fastUntil: CFTimeInterval = 0
    private let launchCover = UIImageView()
    private var launchCoverChecks = 0
    private static var launchPictureURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("launch-picture.png")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        let scripts = config.userContentController
        let chromeMode = UserDefaults.standard.object(forKey: "chromeMode") as? Bool ?? true
        scripts.addUserScript(WKUserScript(source: "window.__dgChromeUA = \(chromeMode);\n" + Self.resource("compat"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: false, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("viewport"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("recorder"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("camhook"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("hooks"), injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true, in: .page))
        scripts.addUserScript(WKUserScript(source: Self.resource("gm-shim") + "\n" + Self.resource("ui") + "\n" + Self.resource("bridge") + "\n" + Self.resource("textscale") + "\n" + Self.resource("header") + "\n" + Self.resource("stories") + "\n" + Self.resource("camera") + "\n" + Self.resource("fit") + "\n" + Self.resource("touch") + "\n" + Self.resource("chat") + "\n" + Self.resource("gestures") + "\n" + Self.cssScript("newchat") + "\n" + Self.cssScript("camera") + "\n" + Self.cssScript("stories") + "\n" + Self.cssScript("header") + "\n" + Self.cssScript("snap") + "\n" + Self.cssScript("chat") + "\n" + Self.cssScript("gestures"),
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        scripts.addScriptMessageHandler(self, contentWorld: world, name: "dg")

        Self.preferHighRefresh(config.preferences)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = Self.userAgent
        // lets Safari's Web Inspector protocol (ios-webkit-debug-proxy on the PC, phone on USB) attach to the page
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // the page is a fixed app layout: only its inner lists scroll, the page itself never rubber-bands
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.allowsLinkPreview = false

        webView.scrollView.delegate = self
        view.addSubview(webView)
        // Launch picture: the chat list as it looked when the app was last left, shown until Snapchat has drawn
        // the real one (a cold start otherwise shows an empty dark screen for a few seconds).
        if let url = Self.launchPictureURL, let picture = UIImage(contentsOfFile: url.path) {
            launchCover.image = picture
            launchCover.contentMode = .scaleToFill
            launchCover.isUserInteractionEnabled = true // just a picture: taps wait for the real page
            view.addSubview(launchCover)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(saveLaunchPicture),
                                               name: UIApplication.willResignActiveNotification, object: nil)
        TouchWindow.onTouch = { [weak self] in self?.renderFast(for: 2.5) }
        buildTabBar()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
        urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] _, _ in
            self?.updateLayoutMode()
        }
        removeInputAccessory()
        // (the page is loaded from viewDidLayoutSubviews, once the web view has its real size)

        let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        back.edges = .left
        view.addGestureRecognizer(back)

        let diagnose = UITapGestureRecognizer(target: self, action: #selector(showDiagnostics))
        diagnose.numberOfTouchesRequired = 3
        diagnose.cancelsTouchesInView = false
        view.addGestureRecognizer(diagnose)
    }

    /// Troubleshooting log that survives page loads: Documents/trail.txt (last 300 lines).
    private var trailLines: [String] = []
    private func trail(_ text: String) {
        let time = String(format: "%.2f", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 10000))
        trailLines.append("\(time) \(text)")
        if trailLines.count > 300 { trailLines.removeFirst(trailLines.count - 300) }
        if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? trailLines.joined(separator: "\n").write(to: dir.appendingPathComponent("trail.txt"), atomically: true, encoding: .utf8)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        trail("NATIVE page load started: \(webView.url?.absoluteString ?? "?")")
    }

    /// Page structure + sizes into Documents/<name>-<time>.html, readable from the PC over USB.
    private func dump(_ name: String, note: String = "") {
        let js = """
        (() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(), c = getComputedStyle(e);
            return [e.tagName, e.className, Math.round(b.width), Math.round(b.height), c.position, c.display, c.height]; };
          const main = document.querySelector('main');
          return '<!-- ' + JSON.stringify({ innerWidth, innerHeight, client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
            vv: window.visualViewport ? [visualViewport.width, visualViewport.height, visualViewport.scale] : null,
            html: r(document.documentElement), body: r(document.body), main: r(main),
            kids: main ? [...main.children].map(r) : [], layout: document.documentElement.className,
            errors: window.__dgErrors ?? [], media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) }) + ' --> '
            + document.documentElement.outerHTML; })()
        """
        let native = "note [\(note)] chat \(chatOpen) stories \(storiesOpen) camera \(cameraOpen) kb \(keyboardOverlap) bounds \(webView.bounds) frame \(webView.frame) zoom \(webView.scrollView.zoomScale) content \(webView.scrollView.contentSize) urls \(urlLog)"
        webView.evaluateJavaScript(js) { result, error in
            guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let html = (result as? String) ?? "dump failed: \(String(describing: error))"
            let stamp = Int(Date().timeIntervalSince1970)
            try? ("<!-- " + native + " -->\n" + html).write(to: dir.appendingPathComponent("\(name)-\(stamp).html"),
                                                           atomically: true, encoding: .utf8)
        }
    }

    /// Three-finger tap: what the page sees (for troubleshooting without a Mac and Web Inspector).
    @objc private func showDiagnostics() {
        let js = """
        JSON.stringify({ url: location.href, innerWidth, screenWidth: screen.width,
          viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
          platform: navigator.platform, touchPoints: navigator.maxTouchPoints,
          hooks: document.documentElement.dataset.dgHooks ?? null, ua: navigator.userAgent,
          errors: window.__dgErrors ?? [], jsUA: navigator.userAgent.includes('Chrome/') ? 'chrome' : 'safari', rec: [typeof VideoEncoder, typeof AudioEncoder, typeof AudioData, typeof MediaStreamTrackProcessor], innerHeight, docHeight: document.documentElement.clientHeight,
          layout: document.documentElement.className,
          grid: document.querySelector('[data-dg-root]')?.getBoundingClientRect().height ?? null,
          urls: \(urlLog.description), inApp: \(inApp) }, null, 1)
        """
        // page structure for troubleshooting layout from the PC (Files > On My iPhone > Snapchat, or USB)
        webView.evaluateJavaScript("document.documentElement.outerHTML") { result, _ in
            guard let html = result as? String,
                  let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let stamp = Int(Date().timeIntervalSince1970)
            try? html.write(to: dir.appendingPathComponent("dom-\(stamp).html"), atomically: true, encoding: .utf8)
        }
        webView.evaluateJavaScript(js) { [weak self] result, error in
            let text = (result as? String) ?? error?.localizedDescription ?? "no result"
            let alert = UIAlertController(title: "Diagnostics", message: text, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Reload", style: .default) { _ in self?.webView.reload() })
            let chrome = UserDefaults.standard.object(forKey: "chromeMode") as? Bool ?? true
            alert.addAction(UIAlertAction(title: chrome ? "Turn Chrome mode off (then reopen the app)" : "Turn Chrome mode on (then reopen the app)",
                                          style: .default) { _ in UserDefaults.standard.set(!chrome, forKey: "chromeMode") })
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            self?.present(alert, animated: true)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let insets = view.safeAreaInsets
        // in a chat the strip under the message box (home indicator) matches the box's keyboard grey
        view.backgroundColor = chatOpen && inApp ? UIColor(red: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255, alpha: 1) : Self.background
        let showBar = inApp && !chatOpen && !storiesOpen && keyboardOverlap == 0
        if showBar != lastShowBar {
            lastShowBar = showBar
            trail("NATIVE bar \(showBar) inApp \(inApp) chat \(chatOpen) stories \(storiesOpen) camera \(cameraOpen) kb \(keyboardOverlap)")
        }
        closeStoriesButton.isHidden = !cameraOpen || previewOpen // stories: Snapchat's own X (top right) and the edge swipe close them
        // camera: top left (Snapchat's own menu sits top right); stories: top right
        closeStoriesButton.frame = CGRect(x: cameraOpen ? 12 : view.bounds.width - 56, y: insets.top + 8, width: 44, height: 44)
        let barTotal = Self.tabBarHeight + insets.bottom
        tabBar.frame = CGRect(x: 0, y: view.bounds.height - (showBar ? barTotal : 0),
                              width: view.bounds.width, height: barTotal)
        tabBar.alpha = showBar ? 1 : 0
        let area = CGRect(x: 0, y: insets.top, width: view.bounds.width,
                          height: (showBar ? tabBar.frame.minY
                                           : view.bounds.height - max(insets.bottom, keyboardOverlap)) - insets.top)
        let scale = inApp ? Self.appScale : min(1, area.width / Self.loginWidth)
        webView.transform = .identity
        webView.bounds = CGRect(x: 0, y: 0, width: area.width / scale, height: area.height / scale)
        webView.center = CGPoint(x: area.midX, y: area.midY)
        webView.transform = CGAffineTransform(scaleX: scale, y: scale)
        // Snapchat sizes its layout from the window when it starts. Loading while the web view was still
        // 0x0 (before this first layout pass) sometimes left it a fraction of the screen tall, stuck in
        // its two-pane desktop layout - so load only now, and poke it after every later size change.
        if launchCover.superview != nil { launchCover.frame = webView.frame }
        if !loaded, area.width > 0, area.height > 0 {
            loaded = true
            webView.load(URLRequest(url: Self.home))
            if launchCover.superview != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.checkLaunchCover() } }
        } else if loaded {
            webView.evaluateJavaScript("dispatchEvent(new Event('resize'))", completionHandler: nil)
        }
    }

    /// The real app's bottom bar (Map, Chat, Camera, Stories, Spotlight), drawn to match its icons.
    /// Snapchat Web only has chats and stories, so Stories opens the web stories viewer and the rest are
    /// placeholders. Hidden on login pages, inside chats and while stories play.
    private func buildTabBar() {
        tabBar.backgroundColor = Self.tabBarColor
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.alignment = .center
        let icons: [(UIImage, Selector?)] = [
            (TabIcons.map, nil), (TabIcons.chat, nil), (TabIcons.camera, #selector(openCamera)),
            (TabIcons.stories(preview: nil), #selector(openStories)), (TabIcons.spotlight, nil),
        ]
        for (image, action) in icons {
            let button = UIButton(type: .custom)
            button.setImage(image, for: .normal)
            button.adjustsImageWhenHighlighted = action != nil
            if let action {
                button.addTarget(self, action: action, for: .touchUpInside)
                if action == #selector(openStories) { storiesButton = button }
            }
            button.heightAnchor.constraint(equalToConstant: 56).isActive = true
            stack.addArrangedSubview(button)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        tabBar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: tabBar.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: tabBar.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: tabBar.topAnchor),
            stack.heightAnchor.constraint(equalToConstant: Self.tabBarHeight),
        ])
        view.addSubview(tabBar)

        closeStoriesButton.setImage(UIImage(systemName: "xmark", withConfiguration:
            UIImage.SymbolConfiguration(pointSize: 18, weight: .bold)), for: .normal)
        closeStoriesButton.tintColor = .white
        closeStoriesButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        closeStoriesButton.layer.cornerRadius = 22
        closeStoriesButton.isHidden = true
        closeStoriesButton.addTarget(self, action: #selector(closeStories), for: .touchUpInside)
        view.addSubview(closeStoriesButton)
    }

    @objc private func closeStories() {
        webView.evaluateJavaScript("window.__dgCloseStories && window.__dgCloseStories()", in: nil, in: world)
    }

    /// Stories: stories.js opens the web viewer full screen (it lives in the pane the phone layout hides).
    // Keyboard: the page is a fixed full-height layout, so instead of letting WebKit scroll it (which, in
    // this scaled web view, pushed the content off the top), the web view itself ends at the keyboard and
    // Snapchat lays out in the space that's left - the message box sits right on top of the keyboard.
    @objc private func keyboardChanged(_ note: Notification) {
        var overlap: CGFloat = 0
        if note.name != UIResponder.keyboardWillHideNotification,
           let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue {
            overlap = max(0, view.bounds.maxY - view.convert(frame, from: nil).minY)
        }
        guard overlap != keyboardOverlap else { return }
        keyboardOverlap = overlap
        // Not animated (same reason as setChatOpen): animating a web view's size stretches its old picture until
        // the page has redrawn, which looked like the page jumping. The message box moves in one step; the strip
        // under it has the box's grey, so the keyboard slides in (or out) against the same colour.
        renderFast(for: 0.6)
        UIView.performWithoutAnimation {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if inApp, scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
    }

    /// Removes the bar iOS puts above the keyboard for web pages (previous / next arrows and the checkmark).
    private func removeInputAccessory() {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let base: AnyClass = object_getClass(content) else { return }
        let name = "\(NSStringFromClass(base))_DGNoAccessory"
        var sub: AnyClass? = NSClassFromString(name)
        if sub == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let sel = #selector(getter: UIResponder.inputAccessoryView)
            if let method = class_getInstanceMethod(UIView.self, sel) {
                class_addMethod(made, sel, imp_implementationWithBlock(block), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            sub = made
        }
        if let sub { object_setClass(content, sub) }
    }

    /// Swipe in from the left edge: back to the chat list (or out of stories), like the real app.
    @objc private func edgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, inApp,
              gesture.translation(in: view).x > 50 || gesture.velocity(in: view).x > 400 else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        webView.evaluateJavaScript("window.__dgBack && window.__dgBack()", in: nil, in: world)
    }

    /// Camera: camera.js opens Snapchat Web's camera (in the pane the phone layout hides) full screen.
    @objc private func openCamera() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        webView.becomeFirstResponder()
        webView.evaluateJavaScript("window.__dgOpenCamera ? window.__dgOpenCamera() : 'missing'", in: nil, in: world) { [weak self] result in
            if case .success(let value) = result, let text = value as? String, text != "ok" {
                let alert = UIAlertController(title: nil, message: "Couldn't open the camera (\(text)).", preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }

    @objc private func openStories() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        webView.becomeFirstResponder()
        webView.evaluateJavaScript("window.__dgOpenStories ? window.__dgOpenStories() : 'missing'",
                                   in: nil, in: world) { [weak self] result in
            if case .success(let value) = result, let text = value as? String, text != "ok" {
                let message = text == "none" ? "No stories to watch right now." : "Couldn't open stories (\(text))."
                let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }

    private func setChatOpen(_ open: Bool, force: Bool = false) {
        guard force || open != chatOpen else { return }
        chatOpen = open
        renderFast(for: 0.8) // the chat's slide-in / fade animation
        // Not animated: an animated bounds change stretches the web view's old picture to the new size for the
        // length of the animation while the page has already re-laid out underneath - on the phone that was the
        // "jumping flash" when opening a chat. chat.js keeps the chat pane hidden until the new size has settled.
        UIView.performWithoutAnimation {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    /// Snapchat Web (/web) at the phone's own width; login and other snapchat.com pages laid out wide.
    private func updateLayoutMode() {
        guard let url = webView.url, let host = url.host?.lowercased() else { return }
        urlLog.append("\(host)\(url.path)")
        if urlLog.count > 8 { urlLog.removeFirst() }
        // Only Snapchat's own pages on www switch modes. Other hosts (accounts.snapchat.com, which a logged-in
        // start can pass through) keep the current mode, so the page doesn't get squeezed to the login
        // width and back while it loads - that left Snapchat stuck in its two-pane desktop layout.
        guard host == "www.snapchat.com" else { return }
        let now = url.path.hasPrefix("/web")
        guard now != inApp else { return }
        inApp = now
        view.setNeedsLayout()
        webView.evaluateJavaScript("window.__dgViewport && window.__dgViewport(\(now))", completionHandler: nil)
        // make sure Snapchat re-measures at the new size
        webView.evaluateJavaScript("setTimeout(() => dispatchEvent(new Event('resize')), 300)", completionHandler: nil)
    }

    /// Backup for the same problem: a few seconds after Snapchat Web loads, glass.js should have switched
    /// to the one-pane phone layout (html.dg-list / dg-chat). If it hasn't, reload once.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard inApp else { return }
        for delay in [0.2, 0.9] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let web = self?.webView else { return }
                var b = web.bounds
                b.size.height -= 1
                web.bounds = b
                DispatchQueue.main.async { self?.view.setNeedsLayout() }
            }
        }
        for delay in [0.3, 1.0, 2.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.webView.evaluateJavaScript("dispatchEvent(new Event('resize'))", completionHandler: nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, self.inApp, !self.healed else { return }
            let check = "document.documentElement.classList.contains('dg-list') || document.documentElement.classList.contains('dg-chat')"
            self.webView.evaluateJavaScript(check) { result, _ in
                guard (result as? Bool) == false else { return }
                self.dump("broken")
                self.healed = true
                self.urlLog.append("self-heal reload")
                // back to the chat list: a fresh load straight into a chat URL doesn't get the phone layout
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.webView.load(URLRequest(url: Self.home)) }
            }
        }
    }

    /// A bundled stylesheet as a script that adds it to the page.
    private static func cssScript(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "css"),
              let css = try? String(contentsOf: url, encoding: .utf8),
              let json = try? JSONSerialization.data(withJSONObject: [css]),
              let literal = String(data: json, encoding: .utf8) else { return "" }
        return "(() => { if (window.top !== window) return; const add = () => { if (!document.documentElement) return void setTimeout(add, 10);"
            + " const s = document.createElement('style'); s.textContent = \(literal)[0]; document.documentElement.appendChild(s); }; add(); })();"
    }

    private static func resource(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return text
    }

    private static func isSnapchat(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return host == "snapchat.com" || host.hasSuffix(".snapchat.com")
    }

    @objc private func reload(_ sender: UIRefreshControl) {
        if webView.url == nil { webView.load(URLRequest(url: Self.home)) } else { webView.reload() }
        sender.endRefreshing()
    }

    // MARK: GM.* backend for ui.js

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "bad message")
        }
        let defaults = UserDefaults.standard
        switch op {
        case "get":
            guard let key = body["key"] as? String else { return replyHandler(nil, "no key") }
            replyHandler(defaults.string(forKey: "gm." + key), nil)
        case "set":
            guard let key = body["key"] as? String else { return replyHandler(nil, "no key") }
            defaults.set(body["value"] as? String, forKey: "gm." + key)
            replyHandler(true, nil)
        case "fetch":
            guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https",
                  let host = url.host, Self.giphyHosts.contains(host) else {
                return replyHandler(nil, "Unsupported GIF host")
            }
            var request = URLRequest(url: url, timeoutInterval: 20)
            request.httpShouldHandleCookies = false
            URLSession.shared.dataTask(with: request) { data, response, error in
                let http = response as? HTTPURLResponse
                DispatchQueue.main.async {
                    if let error { return replyHandler(nil, error.localizedDescription) }
                    replyHandler([
                        "status": http?.statusCode ?? 0,
                        "type": http?.value(forHTTPHeaderField: "Content-Type") ?? "",
                        "body": (data ?? Data()).base64EncodedString(),
                    ], nil)
                }
            }.resume()
        case "trail":
            trail(body["text"] as? String ?? "")
            replyHandler(true, nil)
        case "haptic":
            let style: UIImpactFeedbackGenerator.FeedbackStyle
            switch body["style"] as? String {
            case "medium": style = .medium
            case "heavy": style = .heavy
            default: style = .light
            }
            UIImpactFeedbackGenerator(style: style).impactOccurred()
            replyHandler(true, nil)
        case "dump":
            dump(body["name"] as? String ?? "page", note: body["note"] as? String ?? "")
            replyHandler(true, nil)
        case "storyThumb":
            let data = (body["data"] as? String).flatMap { Data(base64Encoded: $0) }
            let thumb = data.flatMap { UIImage(data: $0) }
            storiesButton?.setImage(TabIcons.stories(preview: thumb), for: .normal)
            replyHandler(true, nil)
        case "mode":
            storiesOpen = body["stories"] as? Bool ?? false
            cameraOpen = body["camera"] as? Bool ?? false
            previewOpen = body["preview"] as? Bool ?? false
            setChatOpen(body["chat"] as? Bool ?? false, force: true)
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame != false { trail("NATIVE navigation type \(action.navigationType.rawValue) to \(url.absoluteString)") }
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            // links out of Snapchat open in Safari; logins, captchas and other frames stay here
            if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame != false, !Self.isSnapchat(url) {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            return decisionHandler(.allow)
        }
        // snapchat://, itms-apps:// and the like: never leave for the App Store or the real app
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.isSnapchat(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        urlLog.append("WEB PROCESS CRASHED")
        if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            let text = "crash at \(Date()) urls \(urlLog)\n"
            try? text.write(to: dir.appendingPathComponent("crash-\(Int(Date().timeIntervalSince1970)).txt"), atomically: true, encoding: .utf8)
        }
        webView.load(URLRequest(url: Self.home))
    }

    // MARK: smoothness

    /// WebKit renders web pages at 60fps on iPhone even on a 120Hz screen. Private switch
    /// (WKPreferences._setEnabled:forFeature: "PreferPageRenderingUpdatesNear60FPSEnabled" = off); on iOS 26 it
    /// only helps together with CADisableMinimumFrameDurationOnPhone and the display link below. Each step is
    /// checked first, so a WebKit without these private methods is simply left alone.
    private static func preferHighRefresh(_ prefs: WKPreferences) {
        let featuresSel = NSSelectorFromString("_features")
        let setSel = NSSelectorFromString("_setEnabled:forFeature:")
        guard let listMethod = class_getClassMethod(WKPreferences.self, featuresSel),
              let method = class_getInstanceMethod(WKPreferences.self, setSel) else { return }
        typealias Features = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>?
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let list = unsafeBitCast(method_getImplementation(listMethod), to: Features.self)
        let setEnabled = unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)
        guard let features = list(WKPreferences.self, featuresSel)?.takeUnretainedValue() as? [NSObject] else { return }
        let keySel = NSSelectorFromString("key")
        for feature in features where feature.responds(to: keySel)
            && (feature.perform(keySel)?.takeUnretainedValue() as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" {
            setEnabled(prefs, setSel, false, feature)
        }
    }

    /// Keeps the screen at up to 120Hz and nudges WebKit to draw at that pace (private
    /// WKWebView._updateVisibleContentRects each frame) - only while a finger is down or an animation runs,
    /// so it costs no battery the rest of the time.
    private func renderFast(for seconds: CFTimeInterval) {
        fastUntil = max(fastUntil, CACurrentMediaTime() + seconds)
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(fastTick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func fastTick(_ link: CADisplayLink) {
        if CACurrentMediaTime() > fastUntil {
            link.invalidate()
            displayLink = nil
            return
        }
        let sel = NSSelectorFromString("_updateVisibleContentRects")
        if webView.responds(to: sel) { webView.perform(sel) }
    }

    /// Saves what the chat list looks like right now, for the launch picture (only the plain chat list: a chat,
    /// the camera or the keyboard would show up in the wrong place next launch).
    @objc private func saveLaunchPicture() {
        guard inApp, !chatOpen, !storiesOpen, !cameraOpen, keyboardOverlap == 0, launchCover.superview == nil,
              let url = Self.launchPictureURL else { return }
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        webView.evaluateJavaScript("document.documentElement.classList.contains('dg-list') && document.querySelectorAll('[role=\"listitem\"]').length > 2") { [weak self] ready, _ in
            guard (ready as? Bool) == true, let self else { return }
            self.webView.takeSnapshot(with: config) { image, _ in
                guard let data = image?.pngData() else { return }
                DispatchQueue.global(qos: .utility).async { try? data.write(to: url, options: .atomic) }
            }
        }
    }

    /// Takes the launch picture away once Snapchat has drawn the real chat list (or after ~9s, or at once on a
    /// login page).
    private func checkLaunchCover() {
        guard launchCover.superview != nil else { return }
        launchCoverChecks += 1
        let js = "document.documentElement.classList.contains('dg-list') && document.querySelectorAll('[role=\"listitem\"]').length > 2 && getComputedStyle(document.body).opacity === '1'"
        webView.evaluateJavaScript(js) { [weak self] ready, _ in
            guard let self else { return }
            if !self.inApp || (ready as? Bool) == true || self.launchCoverChecks > 60 {
                UIView.animate(withDuration: 0.2, delay: 0.1, options: [], animations: { self.launchCover.alpha = 0 }) { _ in
                    self.launchCover.removeFromSuperview()
                    self.launchCover.image = nil
                    self.launchCover.alpha = 1
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.checkLaunchCover() }
            }
        }
    }

    // MARK: permissions and dialogs

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.lowercased()
        decisionHandler(host == "snapchat.com" || host.hasSuffix(".snapchat.com") ? .grant : .prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}

/// Bottom bar icons, drawn after the real Snapchat app's (light grey outlines on #1e1e1e; Stories is the
/// purple story ring).
enum TabIcons {
    private static let grey = UIColor(white: 0.89, alpha: 1)

    private static func draw(_ size: CGFloat = 30, _ body: (CGContext) -> Void) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { body($0.cgContext) }
            .withRenderingMode(.alwaysOriginal)
    }

    private static func stroke(_ path: UIBezierPath) {
        grey.setStroke()
        path.lineWidth = 2.4
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.stroke()
    }

    static let map = draw { _ in
        let pin = UIBezierPath()
        pin.move(to: CGPoint(x: 15, y: 27))
        pin.addCurve(to: CGPoint(x: 5.5, y: 13), controlPoint1: CGPoint(x: 10.5, y: 23), controlPoint2: CGPoint(x: 5.5, y: 18.5))
        pin.addArc(withCenter: CGPoint(x: 15, y: 13), radius: 9.5, startAngle: .pi, endAngle: 0, clockwise: true)
        pin.addCurve(to: CGPoint(x: 15, y: 27), controlPoint1: CGPoint(x: 24.5, y: 18.5), controlPoint2: CGPoint(x: 19.5, y: 23))
        pin.close()
        stroke(pin)
        stroke(UIBezierPath(arcCenter: CGPoint(x: 15, y: 13), radius: 3.6, startAngle: 0, endAngle: 2 * .pi, clockwise: true))
    }

    static let chat = draw { _ in
        let bubble = UIBezierPath()
        bubble.move(to: CGPoint(x: 9.5, y: 4))
        bubble.addLine(to: CGPoint(x: 20.5, y: 4))
        bubble.addArc(withCenter: CGPoint(x: 20.5, y: 8.5), radius: 4.5, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        bubble.addLine(to: CGPoint(x: 25, y: 26.4))
        bubble.addQuadCurve(to: CGPoint(x: 23.2, y: 27), controlPoint: CGPoint(x: 25, y: 28))
        bubble.addLine(to: CGPoint(x: 19.6, y: 23.6))
        bubble.addLine(to: CGPoint(x: 9.5, y: 23.6))
        bubble.addArc(withCenter: CGPoint(x: 9.5, y: 19.1), radius: 4.5, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        bubble.addLine(to: CGPoint(x: 5, y: 8.5))
        bubble.addArc(withCenter: CGPoint(x: 9.5, y: 8.5), radius: 4.5, startAngle: .pi, endAngle: -.pi / 2, clockwise: true)
        bubble.close()
        grey.setFill()
        bubble.fill()
    }

    static let camera = draw { _ in
        let body = UIBezierPath()
        body.move(to: CGPoint(x: 3, y: 13))
        body.addArc(withCenter: CGPoint(x: 7, y: 13), radius: 4, startAngle: .pi, endAngle: -.pi / 2, clockwise: true)
        body.addLine(to: CGPoint(x: 9.5, y: 9))
        body.addLine(to: CGPoint(x: 11, y: 6.5))
        body.addQuadCurve(to: CGPoint(x: 12.5, y: 5.6), controlPoint: CGPoint(x: 11.5, y: 5.6))
        body.addLine(to: CGPoint(x: 17.5, y: 5.6))
        body.addQuadCurve(to: CGPoint(x: 19, y: 6.5), controlPoint: CGPoint(x: 18.5, y: 5.6))
        body.addLine(to: CGPoint(x: 20.5, y: 9))
        body.addLine(to: CGPoint(x: 23, y: 9))
        body.addArc(withCenter: CGPoint(x: 23, y: 13), radius: 4, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        body.addLine(to: CGPoint(x: 27, y: 22))
        body.addArc(withCenter: CGPoint(x: 23, y: 22), radius: 4, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        body.addLine(to: CGPoint(x: 7, y: 26))
        body.addArc(withCenter: CGPoint(x: 7, y: 22), radius: 4, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        body.close()
        stroke(body)
        stroke(UIBezierPath(arcCenter: CGPoint(x: 15, y: 17), radius: 4.6, startAngle: 0, endAngle: 2 * .pi, clockwise: true))
    }

    /// Purple story ring around the first story's thumbnail (grey when there is none).
    static func stories(preview: UIImage?) -> UIImage {
        draw(36) { _ in
            let inner = UIBezierPath(arcCenter: CGPoint(x: 18, y: 18), radius: 13, startAngle: 0, endAngle: 2 * .pi, clockwise: true)
            if let preview {
                inner.addClip()
                preview.draw(in: CGRect(x: 5, y: 5, width: 26, height: 26))
                UIGraphicsGetCurrentContext()?.resetClip()
            } else {
                UIColor(white: 0.28, alpha: 1).setFill()
                inner.fill()
            }
            let ring = UIBezierPath(arcCenter: CGPoint(x: 18, y: 18), radius: 16, startAngle: 0, endAngle: 2 * .pi, clockwise: true)
            ring.lineWidth = 2.6
            UIColor(red: 0xb0 / 255, green: 0x26 / 255, blue: 0xe8 / 255, alpha: 1).setStroke()
            ring.stroke()
        }
    }

    static let spotlight = draw { _ in
        // rounded play triangle (same shape as Snapchat's own Spotlight icon)
        let shape = UIBezierPath()
        shape.move(to: CGPoint(x: 7.5, y: 7.2))
        shape.addQuadCurve(to: CGPoint(x: 10.6, y: 5.4), controlPoint: CGPoint(x: 7.5, y: 3.6))
        shape.addLine(to: CGPoint(x: 24.4, y: 13.2))
        shape.addQuadCurve(to: CGPoint(x: 24.4, y: 16.8), controlPoint: CGPoint(x: 27.4, y: 15))
        shape.addLine(to: CGPoint(x: 10.6, y: 24.6))
        shape.addQuadCurve(to: CGPoint(x: 7.5, y: 22.8), controlPoint: CGPoint(x: 7.5, y: 26.4))
        shape.close()
        stroke(shape)
    }
}
