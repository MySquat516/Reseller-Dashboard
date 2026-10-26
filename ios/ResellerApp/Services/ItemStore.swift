import Foundation
import Observation

/// Hält die Artikel im Speicher und spricht über den APIClient mit dem Server.
@MainActor
@Observable
final class ItemStore {
    private(set) var items: [Item] = []
    private(set) var isLoading = false
    var errorMessage: String?
    /// Ändert sich, wenn eine andere Serveradresse gesetzt wird (Auslöser zum Neuladen).
    private(set) var configurationID = 0

    private(set) var client: APIClient?

    func configure(serverURL: String) {
        let url = APIClient.normalize(serverURL)
        guard url?.absoluteString != client?.baseURL.absoluteString else { return }
        client = url.map { APIClient(baseURL: $0) }
        items = []
        errorMessage = nil
        configurationID += 1
    }

    func load() async {
        guard let client else {
            items = []
            errorMessage = "Noch keine Serveradresse eingestellt (Tab „Einstellungen“)."
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            items = try await client.fetchItems()
            errorMessage = nil
        } catch APIError.cancelled {
            // Abgebrochen (z. B. beim Wegwischen von „Ziehen zum Aktualisieren“): kein Fehler.
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func save(id: Int?, input: ItemInput) async throws {
        let client = try requireClient()
        if let id {
            try await client.updateItem(id: id, input)
        } else {
            _ = try await client.createItem(input)
        }
        await load()
    }

    func delete(id: Int) async throws {
        let client = try requireClient()
        try await client.deleteItem(id: id)
        items.removeAll { $0.id == id }
    }

    func imageURL(for image: ItemImage?) -> URL? {
        guard let image else { return nil }
        return client?.absoluteURL(image.url)
    }

    private func requireClient() throws -> APIClient {
        guard let client else {
            throw APIError.network("Noch keine Serveradresse eingestellt.")
        }
        return client
    }
}
