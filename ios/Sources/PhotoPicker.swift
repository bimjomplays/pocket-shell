import UIKit
import WebKit
import Photos
import PhotosUI // presentLimitedLibraryPicker(from:) lives in PhotosUI
import AVFoundation

/// Ghost's built-in photo/video picker (composer's gallery button): PhotoKit behind a WKURLSchemeHandler for
/// thumbnails/preview, plus the "dg" message-handler ops the picker sheet (ghost/ui.js's buildPhotoSheet)
/// calls for permission, paging, and — since fetch() from the https page into a custom-scheme response is
/// blocked by WebKit as mixed content regardless of CORS headers (verified against real reports; see
/// ghost/BRIDGE_NOTES.md "Photo picker native bridge" for the evidence and why this file still uses the
/// scheme handler for thumbnails/preview, which is a plain resource load, not a fetch()) — the actual bytes
/// for whatever the user picked to send.
///
/// Registered only in Ghost mode (App.swift), on the WKWebViewConfiguration BEFORE the WKWebView is created,
/// as required by `WKWebViewConfiguration.setURLSchemeHandler(_:forURLScheme:)`.
final class GhostPhotoPicker: NSObject, WKURLSchemeHandler, PHPhotoLibraryChangeObserver {
    static let scheme = "ghostphoto"

    private let imageManager = PHCachingImageManager()
    private weak var webView: WKWebView?
    private weak var presenter: UIViewController?
    // WKURLSchemeTask methods must never be called after webView(_:stop:) for that task - Apple's docs call
    // this undefined behaviour, not just a silent no-op. WKURLSchemeTask is a protocol (not a concrete class
    // NSHashTable can hold as ObjectType without an AnyObject-bound generic guarantee), so identity is
    // tracked by ObjectIdentifier instead of a weak collection - a handful of stray identifiers living for
    // the rest of the process is a few bytes, not worth the extra complexity of pruning them.
    private var stoppedTaskIds = Set<ObjectIdentifier>()
    private var fetchResult: PHFetchResult<PHAsset>?
    private var assetsByLocalId: [String: PHAsset] = [:]
    weak var gallery: GhostGallery?

    init(presenter: UIViewController) {
        self.presenter = presenter
        super.init()
        PHPhotoLibrary.shared().register(self)
    }

    deinit {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    /// Called once, right after the WKWebView that owns this scheme handler's configuration is created.
    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let host = url.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return fail(urlSchemeTask, 400) }
        // Path is "/<percent-encoded PHAsset.localIdentifier>" - asset ids contain "/" (e.g. "ABCD-1234/L0/001"),
        // which is exactly why the id is percent-encoded on the JS side before it ever becomes part of a URL.
        // `URL.path` would DECODE that "%2F" back into a literal "/" before we ever see it, indistinguishable
        // from a real path separator - `percentEncodedPath` keeps it as text so removingPercentEncoding (once,
        // on the whole remainder) reconstructs the exact original id instead of silently truncating it.
        let rawPath = String(components.percentEncodedPath.dropFirst())
        guard let id = rawPath.removingPercentEncoding, !id.isEmpty else { return fail(urlSchemeTask, 400) }
        switch host {
        case "thumb":
            let sizeParam = components.queryItems?.first(where: { $0.name == "s" })?.value
            let pixelSize: CGFloat = sizeParam.flatMap { Double($0) }.map { CGFloat($0) } ?? 300
            let highQuality = components.queryItems?.first(where: { $0.name == "hq" })?.value == "1"
            serveThumb(id: id, pixelSize: pixelSize, highQuality: highQuality, task: urlSchemeTask)
        case "full":
            serveFull(id: id, task: urlSchemeTask)
        case "video": // Gallery viewer playback, Range-capable (GalleryLibrary.swift)
            guard let gallery else { return fail(urlSchemeTask, 404) }
            gallery.serveVideo(id: id, task: urlSchemeTask)
        default:
            fail(urlSchemeTask, 404)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stoppedTaskIds.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        stoppedTaskIds.contains(ObjectIdentifier(task))
    }

    private func fail(_ task: WKURLSchemeTask, _ code: Int) {
        guard !isStopped(task) else { return }
        guard let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil) else { return }
        task.didReceive(response)
        if !isStopped(task) { task.didFinish() }
    }

    private func respond(_ task: WKURLSchemeTask, data: Data, mime: String) {
        guard !isStopped(task), let url = task.request.url else { return }
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            // Harmless to send even though fetch() from the https page can't use it (see the file header
            // comment) - a same-scheme or non-CORS consumer (e.g. a future same-origin load) still benefits.
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return fail(task, 500)
        }
        task.didReceive(response)
        guard !isStopped(task) else { return }
        task.didReceive(data)
        guard !isStopped(task) else { return }
        task.didFinish()
    }

    func failTask(_ task: WKURLSchemeTask, _ code: Int) { fail(task, code) }

    /// Serves a file on disk, honouring a single "Range: bytes=a-b" (206) the way <video> asks for media.
    /// The file is memory-mapped, so only the requested slice is ever read. Open-ended ranges are capped
    /// to 8 MB per response (a valid partial answer; the media loader asks again for the rest).
    func respondFile(_ task: WKURLSchemeTask, url: URL, mime: String) {
        guard !isStopped(task), let reqURL = task.request.url else { return }
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else { return fail(task, 500) }
        let total = data.count
        var status = 200
        var slice = 0..<total
        if let range = task.request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes="), total > 0 {
            let spec = range.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
            let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            if parts.count == 2 {
                var start: Int
                var end: Int
                if parts[0].isEmpty { // suffix range: last N bytes
                    let n = Int(parts[1]) ?? 0
                    start = max(0, total - n); end = total - 1
                } else {
                    start = Int(parts[0]) ?? 0
                    end = parts[1].isEmpty ? min(total - 1, start + 8 * 1024 * 1024 - 1) : min(total - 1, Int(parts[1]) ?? (total - 1))
                }
                if start >= total || start > end {
                    let headers = ["Content-Range": "bytes */\(total)"]
                    if let r = HTTPURLResponse(url: reqURL, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: headers) {
                        task.didReceive(r); if !isStopped(task) { task.didFinish() }
                    }
                    return
                }
                start = max(0, start); end = max(start, end)
                slice = start..<(end + 1)
                status = 206
            }
        }
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(slice.count),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
        ]
        if status == 206 { headers["Content-Range"] = "bytes \(slice.lowerBound)-\(slice.upperBound - 1)/\(total)" }
        guard let response = HTTPURLResponse(url: reqURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return fail(task, 500) }
        task.didReceive(response)
        guard !isStopped(task) else { return }
        task.didReceive(data.subdata(in: slice))
        guard !isStopped(task) else { return }
        task.didFinish()
    }

    private func asset(for id: String) -> PHAsset? {
        if let cached = assetsByLocalId[id] { return cached }
        let found = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        if let found { assetsByLocalId[id] = found }
        return found
    }

    private func serveThumb(id: String, pixelSize: CGFloat, highQuality: Bool = false, task: WKURLSchemeTask) {
        guard let asset = asset(for: id) else { return fail(task, 404) }
        let options = PHImageRequestOptions()
        // hq=1 (the Gallery viewer's full-screen image): one high-quality callback instead of .opportunistic's
        // blurry first pass, which the "first callback wins" rule below would otherwise serve at full screen size
        options.deliveryMode = highQuality ? .highQualityFormat : .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false
        let target = CGSize(width: pixelSize, height: pixelSize)
        var delivered = false
        imageManager.requestImage(for: asset, targetSize: target, contentMode: .aspectFill, options: options) { [weak self] image, info in
            guard let self, !delivered else { return }
            // .opportunistic can call back twice (a fast low-res pass, then a better one); a WKURLSchemeTask
            // can only finish once, so only the first callback that actually has image data is used - for a
            // ~300px grid thumbnail the first pass is already good enough that waiting for a second one would
            // only add latency, never visible quality.
            guard let image, let data = image.jpegData(compressionQuality: 0.82) else {
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
                if !degraded { DispatchQueue.main.async { self.fail(task, 500) } }
                return
            }
            delivered = true
            DispatchQueue.main.async { self.respond(task, data: data, mime: "image/jpeg") }
        }
    }

    private func serveFull(id: String, task: WKURLSchemeTask) {
        guard let asset = asset(for: id) else { return fail(task, 404) }
        if asset.mediaType == .video {
            exportVideo(asset: asset) { [weak self] data in
                guard let self else { return }
                if let data { self.respond(task, data: data, mime: "video/mp4") } else { self.fail(task, 500) }
            }
        } else {
            fetchFullImageJPEG(asset: asset) { [weak self] data in
                guard let self else { return }
                if let data { self.respond(task, data: data, mime: "image/jpeg") } else { self.fail(task, 500) }
            }
        }
    }

    private func fetchFullImageJPEG(asset: PHAsset, completion: @escaping (Data?) -> Void) {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false
        options.version = .current
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
            // HEIC (or any other original format) is re-encoded to JPEG here so both the in-picker <img>
            // preview and the eventual chat send always get a format Snapchat Web's own send pipeline and
            // every recipient's viewer can already handle, matching how a plain file-picker JPEG behaves today.
            guard let data, let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
                return DispatchQueue.main.async { completion(nil) }
            }
            DispatchQueue.main.async { completion(jpeg) }
        }
    }

    private func exportVideo(asset: PHAsset, completion: @escaping (Data?) -> Void) {
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        PHImageManager.default().requestExportSession(forVideo: asset, options: options, exportPreset: AVAssetExportPresetMediumQuality) { session, _ in
            guard let session else { return DispatchQueue.main.async { completion(nil) } }
            let outURL = FileManager.default.temporaryDirectory.appendingPathComponent("ghostphoto-\(UUID().uuidString).mp4")
            session.outputURL = outURL
            session.outputFileType = .mp4
            session.exportAsynchronously {
                defer { try? FileManager.default.removeItem(at: outURL) }
                guard session.status == .completed, let data = try? Data(contentsOf: outURL) else {
                    return DispatchQueue.main.async { completion(nil) }
                }
                DispatchQueue.main.async { completion(data) }
            }
        }
    }

    // MARK: - "dg" message-handler ops (called from App.swift's userContentController(_:didReceive:replyHandler:))

    /// op "photoAuth": current status, requesting the system prompt first if it hasn't been decided yet.
    func handleAuth(reply: @escaping (Any?, String?) -> Void) {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard current == .notDetermined else { return reply(["status": Self.statusName(current)], nil) }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            DispatchQueue.main.async { reply(["status": Self.statusName(status)], nil) }
        }
    }

    private static func statusName(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "denied"
        }
    }

    /// op "photoManage": the system's own "Edit Selected Photos…" sheet for a Limited Library grant.
    func handleManage() {
        guard let presenter else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter)
    }

    /// op "photoList": one page of the library, newest first, images and videos only.
    func handleList(offset: Int, limit: Int, reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return DispatchQueue.main.async { reply(["items": [], "hasMore": false], nil) } }
            let result: PHFetchResult<PHAsset>
            if let existing = self.fetchResult {
                result = existing
            } else {
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                                 PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
                result = PHAsset.fetchAssets(with: options)
                self.fetchResult = result
            }
            let total = result.count
            let start = max(0, min(offset, total))
            let end = max(start, min(offset + max(0, limit), total))
            var items: [[String: Any]] = []
            items.reserveCapacity(end - start)
            if start < end {
                result.enumerateObjects(at: IndexSet(integersIn: start..<end)) { asset, _, _ in
                    self.assetsByLocalId[asset.localIdentifier] = asset
                    items.append([
                        "id": asset.localIdentifier,
                        "mediaType": asset.mediaType == .video ? "video" : "image",
                        "duration": asset.duration,
                        "width": asset.pixelWidth,
                        "height": asset.pixelHeight,
                        "date": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
                    ])
                }
            }
            DispatchQueue.main.async { reply(["items": items, "hasMore": end < total], nil) }
        }
    }

    /// op "photoFull": base64 bytes of one asset, for the send path only (see the file header comment for
    /// why sending can't just fetch() the ghostphoto:// URL the preview already used to display it).
    func handleFull(id: String, reply: @escaping (Any?, String?) -> Void) {
        guard let asset = asset(for: id) else { return reply(nil, "not found") }
        if asset.mediaType == .video {
            exportVideo(asset: asset) { data in
                guard let data else { return reply(nil, "couldn't prepare that video") }
                reply(["data": data.base64EncodedString(), "mime": "video/mp4"], nil)
            }
        } else {
            fetchFullImageJPEG(asset: asset) { data in
                guard let data else { return reply(nil, "couldn't prepare that photo") }
                reply(["data": data.base64EncodedString(), "mime": "image/jpeg"], nil)
            }
        }
    }

    // MARK: - PHPhotoLibraryChangeObserver

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let result = self.fetchResult, let details = changeInstance.changeDetails(for: result) {
                self.fetchResult = details.fetchResultAfterChanges
            } else {
                self.fetchResult = nil // no fetch yet, or no change details for it - a fresh handleList() re-fetches
            }
            self.assetsByLocalId.removeAll()
            self.webView?.ghostEval("window.__ghostPhotoChanged && window.__ghostPhotoChanged()")
        }
    }
}
