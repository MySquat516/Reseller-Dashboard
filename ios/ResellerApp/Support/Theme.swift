import SwiftUI
import UIKit

/// Farben wie in der Web-App (Farbstil „Versandetikett“, siehe public/style.css), jeweils für Hell und Dunkel.
/// Die Akzentfarbe selbst steht im Asset-Katalog (AccentColor): Hell Schwarz, Dunkel Signalgelb.
/// Gelb gibt es hell nur als Fläche, nie als Schrift, weil es auf Weiß nicht lesbar ist.
extension Color {
    /// Gewinn und abgeschlossene Verkäufe (--good)
    static let good = Color(light: 0x0B7A4F, dark: 0x4FD08F)
    /// Verluste und Fehler (--bad)
    static let bad = Color(light: 0xC42B2B, dark: 0xFF7A6B)
    /// Warnungen und Versand (--warn); dunkel Orange, damit es nicht wie eine Aktion aussieht
    static let warn = Color(light: 0x8A5A00, dark: 0xFF9F43)
    /// Status „Reserviert“ (--accent2)
    static let reserved = Color(light: 0x5B4FD1, dark: 0xB3A6FF)

    /// Farbe, die automatisch zwischen Hell- und Dunkelmodus wechselt
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
