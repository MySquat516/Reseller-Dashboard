import XCTest
@testable import ResellerApp

final class DraftTests: XCTestCase {
    func testEmptyDraftCannotBeSaved() {
        XCTAssertFalse(ItemDraft().canSave)
    }

    func testTitleMakesDraftSavable() {
        var d = ItemDraft()
        d.title = "  Hoodie "
        XCTAssertTrue(d.canSave)
        XCTAssertEqual(d.makeInput().title, "Hoodie")
    }

    func testInvalidNumberBlocksSaving() {
        var d = ItemDraft()
        d.title = "A"
        d.purchasePrice = "abc"
        XCTAssertTrue(d.hasInvalidNumbers)
        XCTAssertFalse(d.canSave)
    }

    func testMakeInputConvertsNumbersAndDates() throws {
        var d = ItemDraft()
        d.title = "A"
        d.purchasePrice = "8,50"
        d.soldPrice = ""
        d.listedDate = DateCoding.date(from: "2026-10-01")
        let input = d.makeInput()
        XCTAssertEqual(input.purchasePrice, 8.5)
        XCTAssertNil(input.soldPrice)
        XCTAssertEqual(input.listedDate, "2026-10-01")
        XCTAssertNil(input.soldDate)
    }

    func testSoldPriceRuleMovesEarlyStatusToZuVersenden() throws {
        let today = try XCTUnwrap(DateCoding.date(from: "2026-10-21"))
        for early in [ItemStatus.lager, .online, .reserviert] {
            var d = ItemDraft()
            d.status = early
            d.soldPrice = "20"
            d.applySoldPriceRule(today: today)
            XCTAssertEqual(d.status, .zuVersenden)
            XCTAssertEqual(DateCoding.string(from: d.soldDate), "2026-10-21")
        }
    }

    func testSoldPriceRuleKeepsLaterStatusAndExistingDate() throws {
        let day = try XCTUnwrap(DateCoding.date(from: "2026-10-05"))
        var d = ItemDraft()
        d.status = .versendet
        d.soldDate = day
        d.soldPrice = "20"
        d.applySoldPriceRule(today: Date())
        XCTAssertEqual(d.status, .versendet)
        XCTAssertEqual(d.soldDate, day)
    }

    func testSoldBeforeListedWarning() throws {
        var d = ItemDraft()
        d.listedDate = DateCoding.date(from: "2026-10-10")
        d.soldDate = DateCoding.date(from: "2026-10-09")
        XCTAssertTrue(d.soldBeforeListed)
        d.soldDate = DateCoding.date(from: "2026-10-10")
        XCTAssertFalse(d.soldBeforeListed)
    }

    func testProfitPreview() {
        var d = ItemDraft()
        XCTAssertNil(d.profit)
        d.soldPrice = "25"
        d.purchasePrice = "8,5"
        d.fees = "1,5"
        d.shippingCost = "4,19"
        XCTAssertEqual(d.profit ?? 0, 10.81, accuracy: 0.0001)
    }

    func testFilterAktivHidesFinished() throws {
        let json = #"[{"id":1,"title":"A","status":"verkauft","images":[]},{"id":2,"title":"B","status":"online","images":[]}]"#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let items = try decoder.decode([Item].self, from: Data(json.utf8))
        XCTAssertEqual(items.filter { ItemFilter.active.matches($0) }.map(\.id), [2])
        XCTAssertEqual(items.filter { ItemFilter.all.matches($0) }.count, 2)
        XCTAssertEqual(items.filter { ItemFilter.status(.verkauft).matches($0) }.map(\.id), [1])
        XCTAssertTrue(items[0].matches(search: "a"))
        XCTAssertFalse(items[0].matches(search: "xyz"))
    }
}
