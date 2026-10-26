import Foundation

private let germanLocale = Locale(identifier: "de_DE")

extension Double {
    /// „1.234,50 €“
    var eur: String {
        formatted(.currency(code: "EUR").locale(germanLocale))
    }

    /// „37,6 %“
    var percentText: String {
        formatted(.percent.precision(.fractionLength(0...1)).locale(germanLocale))
    }
}

extension Optional where Wrapped == Double {
    var eurOrDash: String { self?.eur ?? "–" }
}

/// Zahlen aus Textfeldern. Akzeptiert „12,50“, „12.50“ und „1.234,56“.
enum NumberParsing {
    static func parse(_ text: String) -> Double? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
        guard !s.isEmpty else { return nil }
        if s.contains(",") {
            s = s.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".")
        }
        guard let value = Double(s), value.isFinite else { return nil }
        return value
    }

    /// Für Textfelder: 12.5 → „12,5“, 8 → „8“, 12.34 → „12,34“.
    static func text(_ value: Double?) -> String {
        guard let value else { return "" }
        let f = NumberFormatter()
        f.locale = germanLocale
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? ""
    }
}

/// Der Server speichert Daten als „yyyy-MM-dd“.
enum DateCoding {
    private static let iso: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let display: DateFormatter = {
        let f = DateFormatter()
        f.locale = germanLocale
        f.dateFormat = "dd.MM.yyyy"
        return f
    }()

    static func date(from text: String?) -> Date? {
        guard let text, text.count >= 10 else { return nil }
        return iso.date(from: String(text.prefix(10)))
    }

    static func string(from date: Date?) -> String? {
        date.map { iso.string(from: $0) }
    }

    /// „2026-10-21“ → „21.10.2026“
    static func displayText(_ text: String?) -> String? {
        date(from: text).map { display.string(from: $0) }
    }
}
