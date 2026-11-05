import Foundation

struct ItemImage: Codable, Hashable, Identifiable {
    let id: Int
    let url: String
}

/// Ein Artikel, wie ihn `GET /api/items` liefert. Die JSON-Schlüssel (snake_case)
/// werden vom Decoder per `.convertFromSnakeCase` auf die Eigenschaften abgebildet.
struct Item: Codable, Identifiable, Hashable {
    let id: Int
    var title: String
    var description: String?
    var size: String?
    var category: String?
    var brand: String?
    var condition: String?
    var status: ItemStatus
    var purchasePrice: Double?
    var purchaseDate: String?
    var listingPrice: Double?
    var listedDate: String?
    var soldPrice: Double?
    var soldDate: String?
    var platform: String?
    var buyer: String?
    var paymentMethod: String?
    var paymentStatus: String?
    var fees: Double?
    var shippingCost: Double?
    var carrier: String?
    var trackingNumber: String?
    var notes: String?
    var createdAt: String?
    var images: [ItemImage]

    /// Gewinn = Verkaufspreis − Einkaufspreis − Gebühren − Versandkosten (nur mit Verkaufspreis).
    var profit: Double? {
        guard let sold = soldPrice else { return nil }
        return sold - (purchasePrice ?? 0) - (fees ?? 0) - (shippingCost ?? 0)
    }

    /// Zählt in den Statistiken als Verkauf: Status ab „Noch nicht versendet“ und Verkaufspreis vorhanden.
    var countsAsSale: Bool {
        status.countsAsSold && soldPrice != nil
    }

    var margin: Double? {
        guard let sold = soldPrice, sold != 0, let profit else { return nil }
        return profit / sold
    }

    // MARK: Sendungsverfolgung

    private static let trackingBases: [String: String] = [
        "dhl": "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=",
        "deutsche post": "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=",
        "dpd": "https://tracking.dpd.de/parcelstatus?locale=de_DE&query=",
        "gls": "https://gls-group.com/DE/de/paketverfolgung?match=",
        "ups": "https://www.ups.com/track?tracknum=",
        "hermes": "https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#"
    ]

    var trackingURL: URL? {
        guard let carrier = carrier?.trimmingCharacters(in: .whitespaces).lowercased(),
              let number = trackingNumber?.trimmingCharacters(in: .whitespaces),
              !number.isEmpty,
              let base = Self.trackingBases[carrier] else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        guard let encoded = number.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: base + encoded)
    }
}
