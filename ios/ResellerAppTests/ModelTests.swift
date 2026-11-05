import XCTest
@testable import ResellerApp

final class ModelTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private let sampleJSON = """
    [{
      "id": 7, "title": "Nike Hoodie", "description": "", "size": "M", "category": "Pullover",
      "brand": "Nike", "condition": "Gut", "status": "zu_versenden",
      "purchase_price": 8.5, "purchase_date": "2026-09-01", "listing_price": 30, "listed_date": "2026-09-02",
      "sold_price": 25, "sold_date": "2026-10-12", "platform": "Vinted", "buyer": "", "payment_method": "PayPal",
      "payment_status": "offen", "fees": 1.5, "shipping_cost": 4.19, "carrier": "DHL", "tracking_number": "00340 43/12",
      "notes": "", "created_at": "2026-09-01 10:00:00",
      "images": [{"id": 3, "url": "/uploads/abc.jpg"}]
    },
    {
      "id": 8, "title": "Ohne Preise", "status": "irgendwas-neues", "purchase_price": null,
      "listing_price": null, "listed_date": null, "sold_price": null, "images": []
    }]
    """

    func testDecodesItemsFromServerJSON() throws {
        let items = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))
        XCTAssertEqual(items.count, 2)
        let a = items[0]
        XCTAssertEqual(a.id, 7)
        XCTAssertEqual(a.status, .zuVersenden)
        XCTAssertEqual(a.purchasePrice, 8.5)
        XCTAssertEqual(a.trackingNumber, "00340 43/12")
        XCTAssertEqual(a.images.first?.url, "/uploads/abc.jpg")
    }

    func testUnknownStatusFallsBackToLager() throws {
        let items = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))
        XCTAssertEqual(items[1].status, .lager)
        XCTAssertNil(items[1].soldPrice)
    }

    func testProfitAndMargin() throws {
        let a = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))[0]
        XCTAssertEqual(a.profit ?? 0, 25 - 8.5 - 1.5 - 4.19, accuracy: 0.0001)
        XCTAssertTrue(a.countsAsSale)
        XCTAssertEqual(a.margin ?? 0, (25 - 8.5 - 1.5 - 4.19) / 25, accuracy: 0.0001)
    }

    func testReservedItemWithSoldPriceDoesNotCountAsSale() throws {
        var a = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))[0]
        a.status = .reserviert
        XCTAssertFalse(a.countsAsSale)
    }

    func testTrackingURLEncodesNumber() throws {
        let a = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))[0]
        let url = try XCTUnwrap(a.trackingURL)
        XCTAssertTrue(url.absoluteString.hasPrefix("https://www.dhl.de/"))
        XCTAssertTrue(url.absoluteString.hasSuffix("00340%2043%2F12"))
    }

    func testNoTrackingURLForUnknownCarrier() throws {
        var a = try decoder().decode([Item].self, from: Data(sampleJSON.utf8))[0]
        a.carrier = "Fahrradkurier"
        XCTAssertNil(a.trackingURL)
    }

    func testStatusRawValuesMatchServer() {
        XCTAssertEqual(ItemStatus.allCases.map(\.rawValue),
                       ["lager", "online", "reserviert", "zu_versenden", "versendet", "verkauft"])
    }
}

final class FormattingTests: XCTestCase {
    func testParsesGermanAndEnglishNumbers() {
        XCTAssertEqual(NumberParsing.parse("12,50"), 12.5)
        XCTAssertEqual(NumberParsing.parse("12.5"), 12.5)
        XCTAssertEqual(NumberParsing.parse("1.234,56"), 1234.56)
        XCTAssertEqual(NumberParsing.parse(" 7 "), 7)
        XCTAssertNil(NumberParsing.parse(""))
        XCTAssertNil(NumberParsing.parse("abc"))
    }

    func testNumberText() {
        XCTAssertEqual(NumberParsing.text(nil), "")
        XCTAssertEqual(NumberParsing.text(8), "8")
        XCTAssertEqual(NumberParsing.text(12.5), "12,5")
        XCTAssertEqual(NumberParsing.text(1234.56), "1234,56")
    }

    func testDateRoundTrip() throws {
        let date = try XCTUnwrap(DateCoding.date(from: "2026-10-21"))
        XCTAssertEqual(DateCoding.string(from: date), "2026-10-21")
        XCTAssertEqual(DateCoding.displayText("2026-10-21"), "21.10.2026")
        XCTAssertNil(DateCoding.date(from: nil))
        XCTAssertNil(DateCoding.date(from: "kaputt"))
    }
}
