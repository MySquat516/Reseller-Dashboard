import Foundation

/// Bearbeitungsstand eines Artikels im Formular. Zahlen sind Text (Eingabe), Daten sind `Date?`.
struct ItemDraft: Equatable {
    var title = ""
    var description = ""
    var size = ""
    var category = ""
    var brand = ""
    var condition = ""
    var status: ItemStatus = .lager
    var purchasePrice = ""
    var purchaseDate: Date?
    var listingPrice = ""
    var listedDate: Date?
    var soldPrice = ""
    var soldDate: Date?
    var platform = ""
    var buyer = ""
    var paymentMethod = ""
    var paymentStatus = "offen"
    var fees = ""
    var shippingCost = ""
    var carrier = ""
    var trackingNumber = ""
    var notes = ""

    init() {}

    init(item: Item?) {
        guard let item else { return }
        title = item.title
        description = item.description ?? ""
        size = item.size ?? ""
        category = item.category ?? ""
        brand = item.brand ?? ""
        condition = item.condition ?? ""
        status = item.status
        purchasePrice = NumberParsing.text(item.purchasePrice)
        purchaseDate = DateCoding.date(from: item.purchaseDate)
        listingPrice = NumberParsing.text(item.listingPrice)
        listedDate = DateCoding.date(from: item.listedDate)
        soldPrice = NumberParsing.text(item.soldPrice)
        soldDate = DateCoding.date(from: item.soldDate)
        platform = item.platform ?? ""
        buyer = item.buyer ?? ""
        paymentMethod = item.paymentMethod ?? ""
        paymentStatus = item.paymentStatus ?? "offen"
        fees = NumberParsing.text(item.fees)
        shippingCost = NumberParsing.text(item.shippingCost)
        carrier = item.carrier ?? ""
        trackingNumber = item.trackingNumber ?? ""
        notes = item.notes ?? ""
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func makeInput() -> ItemInput {
        ItemInput(
            title: trimmed(title),
            description: trimmed(description),
            size: trimmed(size),
            category: trimmed(category),
            brand: trimmed(brand),
            condition: trimmed(condition),
            status: status,
            purchasePrice: NumberParsing.parse(purchasePrice),
            purchaseDate: DateCoding.string(from: purchaseDate),
            listingPrice: NumberParsing.parse(listingPrice),
            listedDate: DateCoding.string(from: listedDate),
            soldPrice: NumberParsing.parse(soldPrice),
            soldDate: DateCoding.string(from: soldDate),
            platform: trimmed(platform),
            buyer: trimmed(buyer),
            paymentMethod: trimmed(paymentMethod),
            paymentStatus: paymentStatus,
            fees: NumberParsing.parse(fees),
            shippingCost: NumberParsing.parse(shippingCost),
            carrier: trimmed(carrier),
            trackingNumber: trimmed(trackingNumber),
            notes: trimmed(notes)
        )
    }

    // MARK: Hilfen fürs Formular

    var canSave: Bool {
        !trimmed(title).isEmpty && !hasInvalidNumbers
    }

    /// Ein Zahlenfeld ist ausgefüllt, lässt sich aber nicht lesen (z. B. „abc“).
    var hasInvalidNumbers: Bool {
        [purchasePrice, listingPrice, soldPrice, fees, shippingCost].contains {
            !trimmed($0).isEmpty && NumberParsing.parse($0) == nil
        }
    }

    var profit: Double? {
        guard let sold = NumberParsing.parse(soldPrice) else { return nil }
        return sold - (NumberParsing.parse(purchasePrice) ?? 0)
            - (NumberParsing.parse(fees) ?? 0) - (NumberParsing.parse(shippingCost) ?? 0)
    }

    var margin: Double? {
        guard let sold = NumberParsing.parse(soldPrice), sold != 0, let profit else { return nil }
        return profit / sold
    }

    /// „Verkauft am“ liegt vor „Online seit“: Speichern klappt, die Standzeit wird aber nicht berechnet.
    var soldBeforeListed: Bool {
        guard let sold = soldDate, let listed = listedDate else { return false }
        let calendar = Calendar.current
        return calendar.startOfDay(for: sold) < calendar.startOfDay(for: listed)
    }

    /// Wie in der Webapp: Wer einen Verkaufspreis einträgt, hat verkauft.
    /// Aus Lager/Online/Reserviert wird „Noch nicht versendet“, das Verkaufsdatum wird auf heute gesetzt.
    mutating func applySoldPriceRule(today: Date = Date()) {
        guard !trimmed(soldPrice).isEmpty, status.isEarlyStage else { return }
        status = .zuVersenden
        if soldDate == nil { soldDate = today }
    }
}
