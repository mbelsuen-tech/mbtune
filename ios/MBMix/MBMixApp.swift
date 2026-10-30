// MB Soundtools · MBMix para iPad
// La interfaz y el motor (modelos de mesa, OSC, demo, escenas…) son los mismos archivos web de MBMix
// (carpeta "web", dentro de la app). Esta parte nativa solo aporta lo que Safari no puede hacer:
// hablar con la mesa por UDP, buscar mesas en la red, guardar datos y mantener la pantalla encendida.
import SwiftUI
import WebKit
import Darwin

@main
struct MBMixApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                .background(Color.black)
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> Bridge { Bridge() }

    func makeUIView(context: Context) -> WKWebView {
        let bridge = context.coordinator
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "mbmix")
        // Datos guardados disponibles antes de que arranque la página
        ucc.addUserScript(WKUserScript(source: "window.MBNativeStore = \(Storage.json());",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { web.isInspectable = true }
        bridge.webView = web
        if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Datos de la app (mezclas, capas, preferencias) guardados en el iPad
enum Storage {
    static let key = "mbmix.store"
    static func all() -> [String: String] { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }
    static func set(_ k: String, _ v: String) { var d = all(); d[k] = v; UserDefaults.standard.set(d, forKey: key) }
    static func json() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: all()), let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// Puente entre la página y la red del iPad
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private var fd: Int32 = -1

    override init() {
        super.init()
        openSocket()
    }

    // MARK: UDP
    private func openSocket() {
        fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = INADDR_ANY
        _ = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private func readLoop() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while fd >= 0 {
            var from = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let n = withUnsafeMutablePointer(to: &from) { ptr -> Int in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buffer, buffer.count, 0, $0, &len) }
            }
            if n <= 0 { Thread.sleep(forTimeInterval: 0.01); continue }
            let ip = String(cString: inet_ntoa(from.sin_addr))
            let port = Int(UInt16(bigEndian: from.sin_port))
            let b64 = Data(buffer[0..<n]).base64EncodedString()
            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript("MBNative.recv('\(ip)',\(port),'\(b64)')", completionHandler: nil)
            }
        }
    }

    private func send(_ data: Data, to ip: String, port: Int) {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(truncatingIfNeeded: port).bigEndian)
        guard inet_pton(AF_INET, ip, &addr.sin_addr) == 1 else { return }
        data.withUnsafeBytes { raw in
            _ = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, raw.baseAddress, data.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
    }

    // MARK: búsqueda de mesas (sin permiso de multicast: se pregunta a cada dirección de la red)
    private func localIPv4() -> (ip: UInt32, mask: UInt32)? {
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return nil }
        defer { freeifaddrs(ifap) }
        var result: (UInt32, UInt32)?
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            guard let a = ifa.ifa_addr, a.pointee.sa_family == UInt8(AF_INET), let m = ifa.ifa_netmask else { continue }
            let name = String(cString: ifa.ifa_name)
            if name.hasPrefix("lo") { continue }
            let ip = a.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let mask = m.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            if result == nil || name == "en0" { result = (ip, mask) }
        }
        return result
    }

    private func scan(wing: Data, xair: Data) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            self.send(wing, to: "255.255.255.255", port: 2222)
            self.send(xair, to: "255.255.255.255", port: 10024)
            guard let (ip, maskRaw) = self.localIPv4() else { return }
            let mask = maskRaw < 0xFFFFFE00 ? UInt32(0xFFFFFF00) : maskRaw   // como mucho, la /24 del iPad
            let net = ip & mask, count = (~mask) & 0xFFFFFFFF
            guard count > 1 else { return }
            for host in 1..<count where (net | host) != ip {
                let a = net | host
                let s = "\(a >> 24 & 255).\(a >> 16 & 255).\(a >> 8 & 255).\(a & 255)"
                self.send(wing, to: s, port: 2222)
                self.send(xair, to: s, port: 10024)
                if host % 32 == 0 { Thread.sleep(forTimeInterval: 0.005) }
            }
        }
    }

    // MARK: mensajes de la página
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        switch op {
        case "send":
            if let ip = body["ip"] as? String, let port = (body["port"] as? NSNumber)?.intValue,
               let s = body["data"] as? String, let data = Data(base64Encoded: s) {
                send(data, to: ip, port: port)
            }
        case "scan":
            if let w = body["wing"] as? String, let x = body["xair"] as? String,
               let wd = Data(base64Encoded: w), let xd = Data(base64Encoded: x) {
                scan(wing: wd, xair: xd)
            }
        case "save":
            if let k = body["key"] as? String, let v = body["value"] as? String { Storage.set(k, v) }
        case "awake":
            UIApplication.shared.isIdleTimerDisabled = (body["on"] as? Bool) ?? false
        default:
            break
        }
    }
}
