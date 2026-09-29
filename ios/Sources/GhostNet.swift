import Foundation
import Security

/// Native side of the Ghost network (ui.js section "Ghost network"): the private line between two Ghost apps.
/// - "gnet": HTTPS to ntfy.sh only (each Ghost's inbox is an ntfy topic; everything in it is encrypted and signed by
///   ui.js with WebCrypto). The page can't fetch ntfy.sh itself (Snapchat's content security policy), so it goes here.
/// - "gnKeys": this Ghost's key pair (JWK JSON) in the Keychain, so clearing website data doesn't change your Ghost ID.
enum GhostNet {
    private static let service = "com.dltnp.ghost.network"

    static func handle(_ op: String, _ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch op {
        case "gnet": request(body, reply: reply)
        case "gnKeys":
            // replies {"keys": String|null}; a Keychain error is an error (ui.js must never treat it as "no keys" and
            // make new ones, which would replace this Ghost's identity). slot "farewell": the old keys after Leave,
            // kept only while goodbyes to friends are still owed.
            let account = (body["slot"] as? String) == "farewell" ? "farewell" : "keys"
            if let value = body["set"] as? String {
                let status = kcSet(account, Data(value.utf8))
                status == errSecSuccess ? reply(true, nil) : reply(nil, "keychain \(status)")
            } else if body["delete"] as? Bool == true {
                kcDelete(account); reply(true, nil)
            } else {
                switch kcGet(account) {
                case .found(let data):
                    if let text = String(data: data, encoding: .utf8) { reply(["keys": text], nil) } else { reply(nil, "keychain: unreadable") }
                case .none: reply(["keys": NSNull()], nil)
                case .error(let status): reply(nil, "keychain \(status)")
                }
            }
        default: reply(nil, "unknown op")
        }
    }

    /// Only ntfy.sh, no redirects to anywhere else, and at most 4 MB per response (pictures are ~200 KB).
    private final class Guard: NSObject, URLSessionDataDelegate {
        static let maxBytes = 4 * 1024 * 1024
        private var tasks: [Int: (data: Data, done: (Data?, HTTPURLResponse?, String?) -> Void)] = [:]
        private let lock = NSLock()
        func add(_ task: URLSessionTask, _ done: @escaping (Data?, HTTPURLResponse?, String?) -> Void) {
            lock.lock(); tasks[task.taskIdentifier] = (Data(), done); lock.unlock()
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url?.scheme == "https" && request.url?.host == "ntfy.sh" ? request : nil)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            completionHandler(response.expectedContentLength > Int64(Guard.maxBytes) ? .cancel : .allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock()
            if var entry = tasks[dataTask.taskIdentifier] {
                entry.data.append(data)
                tasks[dataTask.taskIdentifier] = entry
                if entry.data.count > Guard.maxBytes { lock.unlock(); dataTask.cancel(); return }
            }
            lock.unlock()
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock(); let entry = tasks.removeValue(forKey: task.taskIdentifier); lock.unlock()
            guard let entry else { return }
            let http = task.response as? HTTPURLResponse
            if let error { entry.done(nil, http, error.localizedDescription) } else { entry.done(entry.data, http, nil) }
        }
    }
    private static let guardDelegate = Guard()
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: guardDelegate, delegateQueue: nil)
    }()

    private static func request(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host == "ntfy.sh" else {
            return reply(nil, "Ghost network only talks to ntfy.sh")
        }
        let method = (body["method"] as? String ?? "GET").uppercased()
        guard ["GET", "POST", "PUT"].contains(method) else { return reply(nil, "bad method") }
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        if let b64 = body["body"] as? String { request.httpBody = Data(base64Encoded: b64) }
        for (k, v) in (body["headers"] as? [String: String] ?? [:]) where ["Filename", "Cache", "Firebase", "X-Poll-ID"].contains(k) {
            request.setValue(v, forHTTPHeaderField: k)
        }
        let task = session.dataTask(with: request)
        guardDelegate.add(task) { data, http, error in
            DispatchQueue.main.async {
                if let error { return reply(nil, error) }
                reply(["status": http?.statusCode ?? 0, "body": (data ?? Data()).base64EncodedString()], nil)
            }
        }
        task.resume()
    }

    // MARK: Keychain (this device only; readable after the first unlock so a background refresh could use it later)
    private enum Read { case found(Data), none, error(OSStatus) }
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    /// Update in place (never delete-then-add: a failed add would lose the keys)
    private static func kcSet(_ account: String, _ data: Data) -> OSStatus {
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(base(account) as CFDictionary, update as CFDictionary)
        if status != errSecItemNotFound { return status }
        var q = base(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil)
    }
    private static func kcGet(_ account: String) -> Read {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return .none }
        guard status == errSecSuccess, let data = out as? Data else { return .error(status) }
        return .found(data)
    }
    private static func kcDelete(_ account: String) { SecItemDelete(base(account) as CFDictionary) }
}
