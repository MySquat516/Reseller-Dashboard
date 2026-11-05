import Foundation

enum APIError: LocalizedError {
    case cancelled
    case network(String)
    case server(String)
    case decoding

    var errorDescription: String? {
        switch self {
        case .cancelled: return nil
        case .network(let text): return text
        case .server(let text): return "Der Server meldet: \(text)"
        case .decoding: return "Die Antwort des Servers konnte nicht gelesen werden. Läuft auf dem Server die aktuelle Version?"
        }
    }
}

private struct ServerError: Decodable {
    let error: String
}

private struct CreatedResponse: Decodable {
    let id: Int
}

/// Dünne Schicht über die REST-API des Reseller-Dashboards.
struct APIClient {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 12
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    /// Macht aus Eingaben wie „192.168.1.20:3000“ oder „http://server:3000/“ eine saubere Basis-URL.
    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// Macht aus „/uploads/abc.jpg“ eine vollständige Adresse.
    func absoluteURL(_ path: String) -> URL? {
        URL(string: baseURL.absoluteString + (path.hasPrefix("/") ? path : "/" + path))
    }

    // MARK: Artikel

    func fetchItems() async throws -> [Item] {
        let data = try await send("GET", "/api/items")
        return try decode([Item].self, from: data)
    }

    func createItem(_ input: ItemInput) async throws -> Int {
        let data = try await send("POST", "/api/items", body: try encode(input))
        return try decode(CreatedResponse.self, from: data).id
    }

    func updateItem(id: Int, _ input: ItemInput) async throws {
        _ = try await send("PUT", "/api/items/\(id)", body: try encode(input))
    }

    func deleteItem(id: Int) async throws {
        _ = try await send("DELETE", "/api/items/\(id)")
    }

    // MARK: Intern

    private func encode(_ input: ItemInput) throws -> Data {
        try JSONEncoder().encode(input)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    private func send(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        guard let url = URL(string: baseURL.absoluteString + path) else {
            throw APIError.network("Die Serveradresse ist ungültig.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.network("Ungültige Antwort vom Server.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let message = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
                throw APIError.server(message ?? "HTTP \(http.statusCode)")
            }
            return data
        } catch let error as APIError {
            throw error
        } catch is CancellationError {
            throw APIError.cancelled
        } catch let error as URLError {
            throw Self.map(error)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
    }

    private static func map(_ error: URLError) -> APIError {
        switch error.code {
        case .cancelled:
            return .cancelled
        case .timedOut:
            return .network("Zeitüberschreitung. Ist der Server an und das VPN verbunden?")
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return .network("Der Server ist nicht erreichbar. Ist das VPN verbunden und die Adresse richtig?")
        case .appTransportSecurityRequiresSecureConnection:
            return .network("iOS blockiert die unverschlüsselte Verbindung (HTTP).")
        default:
            return .network(error.localizedDescription)
        }
    }
}
