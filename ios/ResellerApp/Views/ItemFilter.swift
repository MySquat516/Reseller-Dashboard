import Foundation

/// Filter der Artikelliste. „Aktiv“ blendet abgeschlossene (Status „Verkauft“) Artikel aus.
enum ItemFilter: Hashable {
    case active
    case all
    case status(ItemStatus)

    static let options: [ItemFilter] =
        [ItemFilter.active, ItemFilter.all] + ItemStatus.allCases.map { ItemFilter.status($0) }

    var label: String {
        switch self {
        case .active: return "Aktiv"
        case .all: return "Alle Status"
        case .status(let status): return status.label
        }
    }

    func matches(_ item: Item) -> Bool {
        switch self {
        case .active: return item.status != .verkauft
        case .all: return true
        case .status(let status): return item.status == status
        }
    }
}

extension Item {
    func matches(search query: String) -> Bool {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return true }
        let fields: [String?] = [title, brand, category, description, platform]
        return fields.contains { ($0 ?? "").localizedCaseInsensitiveContains(text) }
    }
}
