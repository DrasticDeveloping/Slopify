import Foundation
import NodeMobile

/// Slopify's music server (server/main.mjs, started through nodejs-project/start.mjs), run inside the app by nodejs-mobile.
/// It finds, saves and plays music just as it does on a computer, with the library
/// kept in the app's Application Support folder; the app's pages come from it
/// (mobile/boot/index.html opens them once it's answering).
enum NodeServer {
    /// Also an origin the Clerk production instance allows, so accounts work in the app.
    static let port = 5198

    static func start() {
        guard let project = Bundle.main.path(forResource: "nodejs-project", ofType: nil) else {
            NSLog("[slopify] nodejs-project is missing from the app bundle")
            return
        }
        let library = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("library", isDirectory: true)
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
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
