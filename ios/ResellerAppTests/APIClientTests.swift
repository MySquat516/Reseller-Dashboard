import XCTest
@testable import ResellerApp

/// Fängt alle Anfragen ab, sodass die Tests ohne echten Server laufen.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        if let body = request.httpBody {
            Self.lastBody = body
        } else if let stream = request.httpBodyStream {
            Self.lastBody = Self.readAll(stream)
        }
        let (status, data) = Self.handler?(request) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readAll(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class APIClientTests: XCTestCase {
    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(baseURL: URL(string: "http://server:3000")!, session: URLSession(configuration: config))
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        StubURLProtocol.lastRequest = nil
        StubURLProtocol.lastBody = nil
    }

    func testNormalizeAddsSchemeAndStripsSlash() {
        XCTAssertEqual(APIClient.normalize("192.168.1.5:3000")?.absoluteString, "http://192.168.1.5:3000")
        XCTAssertEqual(APIClient.normalize("  http://nas.local:3000/ ")?.absoluteString, "http://nas.local:3000")
        XCTAssertEqual(APIClient.normalize("https://shop.example.org")?.absoluteString, "https://shop.example.org")
    }

    func testNormalizeRejectsGarbage() {
        XCTAssertNil(APIClient.normalize(""))
        XCTAssertNil(APIClient.normalize("   "))
        XCTAssertNil(APIClient.normalize("ftp://server"))
        XCTAssertNil(APIClient.normalize("http://"))
    }

    func testAbsoluteURLForImages() {
        let client = makeClient()
        XCTAssertEqual(client.absoluteURL("/uploads/a.jpg")?.absoluteString, "http://server:3000/uploads/a.jpg")
        XCTAssertEqual(client.absoluteURL("uploads/a.jpg")?.absoluteString, "http://server:3000/uploads/a.jpg")
    }

    func testFetchItems() async throws {
        StubURLProtocol.handler = { _ in
            (200, Data(#"[{"id":1,"title":"A","status":"online","images":[]}]"#.utf8))
        }
        let items = try await makeClient().fetchItems()
        XCTAssertEqual(items.map(\.title), ["A"])
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.absoluteString, "http://server:3000/api/items")
    }

    func testServerErrorMessageIsPassedOn() async {
        StubURLProtocol.handler = { _ in (400, Data(#"{"error":"Titel fehlt"}"#.utf8)) }
        do {
            _ = try await makeClient().createItem(Self.sampleInput())
            XCTFail("Fehler erwartet")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Der Server meldet: Titel fehlt")
        }
    }

    func testCreateReturnsId() async throws {
        StubURLProtocol.handler = { _ in (201, Data(#"{"id":42}"#.utf8)) }
        let id = try await makeClient().createItem(Self.sampleInput())
        XCTAssertEqual(id, 42)
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "POST")
    }

    func testInputEncodesNullsAndSnakeCase() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }
        try await makeClient().updateItem(id: 5, Self.sampleInput())
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "PUT")
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "/api/items/5")
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["status"] as? String, "zu_versenden")
        XCTAssertEqual(json["purchase_price"] as? Double, 8.5)
        XCTAssertTrue(json["sold_price"] is NSNull)
        XCTAssertTrue(json["sold_date"] is NSNull)
        XCTAssertEqual(json["tracking_number"] as? String, "123")
    }

    func testDeleteUsesDeleteMethod() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }
        try await makeClient().deleteItem(id: 9)
        XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "DELETE")
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "/api/items/9")
    }

    func testUnreadableResponseGivesDecodingError() async {
        StubURLProtocol.handler = { _ in (200, Data("kein json".utf8)) }
        do {
            _ = try await makeClient().fetchItems()
            XCTFail("Fehler erwartet")
        } catch {
            XCTAssertTrue(error is APIError)
        }
    }

    private static func sampleInput() -> ItemInput {
        ItemInput(title: "A", description: "", size: "", category: "", brand: "", condition: "",
                  status: .zuVersenden, purchasePrice: 8.5, purchaseDate: nil, listingPrice: nil, listedDate: nil,
                  soldPrice: nil, soldDate: nil, platform: "", buyer: "", paymentMethod: "", paymentStatus: "offen",
                  fees: nil, shippingCost: nil, carrier: "DHL", trackingNumber: "123", notes: "")
    }
}
