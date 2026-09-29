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
            if let value = body["set"] as? String {
                reply(kcSet("keys", Data(value.utf8)), nil)
            } else if body["delete"] as? Bool == true {
                kcDelete("keys"); reply(true, nil)
            } else {
                let data = kcGet("keys")
                reply(data.flatMap { String(data: $0, encoding: .utf8) }, nil)
            }
        default: reply(nil, "unknown op")
        }
    }

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
        URLSession.shared.dataTask(with: request) { data, response, error in
            let http = response as? HTTPURLResponse
            DispatchQueue.main.async {
                if let error { return reply(nil, error.localizedDescription) }
                reply(["status": http?.statusCode ?? 0, "body": (data ?? Data()).base64EncodedString()], nil)
            }
        }.resume()
    }

    // MARK: Keychain (this device only; readable after the first unlock so a background refresh could use it later)
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private static func kcSet(_ account: String, _ data: Data) -> Bool {
        kcDelete(account)
        var q = base(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    private static func kcGet(_ account: String) -> Data? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    private static func kcDelete(_ account: String) { SecItemDelete(base(account) as CFDictionary) }
}
