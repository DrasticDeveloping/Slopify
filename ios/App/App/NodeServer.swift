import Foundation
import NodeMobile
import Security

/// Slopify's music server (server/main.mjs, started through nodejs-project/start.mjs), run inside the app by nodejs-mobile.
/// It finds, saves and plays music just as it does on a computer, with the library
/// kept in the app's Application Support folder; the app's pages come from it
/// (mobile/boot/index.html opens them once it's answering).
enum NodeServer {
    /// Also an origin the Clerk production instance allows, so accounts work in the app.
    static let port = 5198
    // This value stays in native memory and an HttpOnly cookie, never page JavaScript.
    static let secret: String = {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            fatalError("iOS couldn't create the library's private session.")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }()
    private static let statusFile = FileManager.default.temporaryDirectory.appendingPathComponent("slopify-startup.json")

    static var sessionCookie: HTTPCookie {
        HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/api/", .name: "slopify_session",
                               .value: secret, HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                               HTTPCookiePropertyKey("SameSite"): "Strict"])!
    }

    /// The boot page must not mistake another app on our port for the music server.
    static func status(_ completion: @escaping ([String: Any]) -> Void) {
        let startup = (try? Data(contentsOf: statusFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        guard startup?["state"] as? String == "ready" else {
            completion(["ready": false, "error": startup?["state"] as? String == "error" ? startup?["message"] as? String ?? "The music server couldn't start." : ""])
            return
        }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("slopify_session=\(secret)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let health = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            // Node writes readiness only after binding. A foreign listener cannot satisfy this check.
            let ready = (response as? HTTPURLResponse)?.statusCode == 200 && health?["ok"] as? Bool == true
            let result: [String: Any] = ["ready": ready, "error": ""]
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    static func start() {
        guard let project = Bundle.main.path(forResource: "nodejs-project", ofType: nil) else {
            NSLog("[slopify] nodejs-project is missing from the app bundle")
            return
        }
        let library = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("library", isDirectory: true)
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: statusFile)
        setenv("SLOPIFY_EMBEDDED", "1", 1)
        setenv("SLOPIFY_EMBEDDED_SECRET", secret, 1)
        setenv("SLOPIFY_EMBEDDED_STATUS", statusFile.path, 1)
        let arguments = ["node", "\(project)/start.mjs", "--host", "127.0.0.1", "--port", String(port), "--data", library.path]
        // Node runs once per process, on its own thread with room for its stack.
        let thread = Thread { run(arguments) }
        thread.name = "slopify-node"
        thread.stackSize = 2 * 1024 * 1024
        thread.start()
    }

    /// node_start needs every argument in one contiguous block (libuv reuses it for the process title).
    private static func run(_ arguments: [String]) {
        let strings = arguments.map { Array($0.utf8CString) }
        let block = UnsafeMutablePointer<CChar>.allocate(capacity: strings.reduce(0) { $0 + $1.count })
        let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: strings.count + 1)
        var offset = 0
        for (i, string) in strings.enumerated() {
            (block + offset).initialize(from: string, count: string.count)
            argv[i] = block + offset
            offset += string.count
        }
        argv[strings.count] = nil
        let code = node_start(Int32(strings.count), argv)
        NSLog("[slopify] The music server stopped (exit code \(code))")
    }
}
