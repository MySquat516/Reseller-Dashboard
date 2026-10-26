import SwiftUI

/// Ablauf: Lager → Online → Reserviert → Noch nicht versendet → Versendet → Verkauft (abgeschlossen).
/// Die Rohwerte entsprechen den Werten, die der Server speichert.
enum ItemStatus: String, CaseIterable, Identifiable, Codable {
    case lager
    case online
    case reserviert
    case zuVersenden = "zu_versenden"
    case versendet
    case verkauft

    var id: String { rawValue }

    var label: String {
        switch self {
        case .lager: return "Lager"
        case .online: return "Online"
        case .reserviert: return "Reserviert"
        case .zuVersenden: return "Noch nicht versendet"
        case .versendet: return "Versendet"
        case .verkauft: return "Verkauft"
        }
    }

    /// Ab „Noch nicht versendet“ zählt ein Artikel mit Verkaufspreis als Verkauf (wie im Server).
    var countsAsSold: Bool {
        self == .zuVersenden || self == .versendet || self == .verkauft
    }

    /// Noch nicht gekauft: Lager, Online, Reserviert.
    var isEarlyStage: Bool {
        self == .lager || self == .online || self == .reserviert
    }

    var color: Color {
        switch self {
        case .lager: return .gray
        case .online: return .blue
        case .reserviert: return .purple
        case .zuVersenden: return .orange
        case .versendet: return .teal
        case .verkauft: return .green
        }
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ItemStatus(rawValue: raw) ?? .lager
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
