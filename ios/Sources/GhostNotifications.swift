import UIKit
import WebKit
import UserNotifications

/// New-message notifications while Ghost runs in the background (Settings > Chats > Message Notifications).
/// Snapchat's own pushes go to Snapchat's app, and iOS Web Push only reaches home-screen web apps, not a WKWebView,
/// so these are LOCAL notifications Ghost posts itself when ghost/ui.js sees a new chat arrive while the app is in
/// the background. They only happen while iOS keeps Ghost running (Keep Ghost Awake helps; not guaranteed).
/// Tapping one opens that chat. Streak Keeper's scheduled reminders ("ghost-streak-*") pass through untouched.
final class GhostNotifications: NSObject, UNUserNotificationCenterDelegate {
    private weak var webView: WKWebView?
    private var pendingChat: String?

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func attach(to webView: WKWebView) { self.webView = webView }

    /// op "notifyMessage" {id, title, body}: one notification per chat (a newer one replaces the older).
    func post(id: String, title: String, body: String, reply: @escaping (Any?, String?) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return DispatchQueue.main.async { reply(["posted": false], nil) } }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.threadIdentifier = "ghost-chat-" + id
            content.userInfo = ["ghostChat": id]
            center.add(UNNotificationRequest(identifier: "ghost-msg-" + id, content: content, trigger: nil)) { error in
                DispatchQueue.main.async { reply(["posted": error == nil], nil) }
            }
        }
    }

    /// op "clearMessageNotifications" {id?}: when a chat is opened in Ghost, its notification goes away.
    func clear(id: String?) {
        let center = UNUserNotificationCenter.current()
        if let id {
            center.removeDeliveredNotifications(withIdentifiers: ["ghost-msg-" + id])
        } else {
            center.getDeliveredNotifications { list in
                center.removeDeliveredNotifications(withIdentifiers: list.map(\.request.identifier).filter { $0.hasPrefix("ghost-msg-") })
            }
        }
    }

    /// A tap cold-launches or resumes Ghost; the chat opens once ui.js is there to take it.
    func takePendingChat() -> String? { defer { pendingChat = nil }; return pendingChat }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // in the foreground the chat list already shows it; Streak Keeper reminders still show as banners
        if notification.request.identifier.hasPrefix("ghost-msg-") { completionHandler([]) } else { completionHandler([.banner, .sound]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard let id = response.notification.request.content.userInfo["ghostChat"] as? String else { return }
        pendingChat = id
        guard let data = try? JSONSerialization.data(withJSONObject: [id]), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.ghostEval("window.__ghostOpenChat && window.__ghostOpenChat(\(json)[0])")
        }
    }
}
