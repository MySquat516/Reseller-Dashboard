import Foundation

/// Der Body für `POST /api/items` und `PUT /api/items/:id`.
/// Leere Zahlen und Daten werden bewusst als `null` gesendet, damit der Server sie leert.
struct ItemInput: Encodable {
    var title: String
    var description: String
    var size: String
    var category: String
    var brand: String
    var condition: String
    var status: ItemStatus
    var purchasePrice: Double?
    var purchaseDate: String?
    var listingPrice: Double?
    var listedDate: String?
    var soldPrice: Double?
    var soldDate: String?
    var platform: String
    var buyer: String
    var paymentMethod: String
    var paymentStatus: String
    var fees: Double?
    var shippingCost: Double?
    var carrier: String
    var trackingNumber: String
    var notes: String

    enum CodingKeys: String, CodingKey {
        case title, description, size, category, brand, condition, status
        case purchasePrice = "purchase_price"
        case purchaseDate = "purchase_date"
        case listingPrice = "listing_price"
        case listedDate = "listed_date"
        case soldPrice = "sold_price"
        case soldDate = "sold_date"
        case platform, buyer
        case paymentMethod = "payment_method"
        case paymentStatus = "payment_status"
        case fees
        case shippingCost = "shipping_cost"
        case carrier
        case trackingNumber = "tracking_number"
        case notes
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        try c.encode(description, forKey: .description)
        try c.encode(size, forKey: .size)
        try c.encode(category, forKey: .category)
        try c.encode(brand, forKey: .brand)
        try c.encode(condition, forKey: .condition)
        try c.encode(status, forKey: .status)
        try Self.put(purchasePrice, .purchasePrice, in: &c)
        try Self.put(purchaseDate, .purchaseDate, in: &c)
        try Self.put(listingPrice, .listingPrice, in: &c)
        try Self.put(listedDate, .listedDate, in: &c)
        try Self.put(soldPrice, .soldPrice, in: &c)
        try Self.put(soldDate, .soldDate, in: &c)
        try c.encode(platform, forKey: .platform)
        try c.encode(buyer, forKey: .buyer)
        try c.encode(paymentMethod, forKey: .paymentMethod)
        try c.encode(paymentStatus, forKey: .paymentStatus)
        try Self.put(fees, .fees, in: &c)
        try Self.put(shippingCost, .shippingCost, in: &c)
        try c.encode(carrier, forKey: .carrier)
        try c.encode(trackingNumber, forKey: .trackingNumber)
        try c.encode(notes, forKey: .notes)
    }

    private static func put<T: Encodable>(_ value: T?, _ key: CodingKeys,
                                          in c: inout KeyedEncodingContainer<CodingKeys>) throws {
        if let value {
            try c.encode(value, forKey: key)
        } else {
            try c.encodeNil(forKey: key)
        }
    }
}
