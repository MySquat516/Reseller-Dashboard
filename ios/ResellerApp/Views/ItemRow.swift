import SwiftUI

struct ItemRow: View {
    @Environment(ItemStore.self) private var store
    let item: Item

    var body: some View {
        HStack(spacing: 12) {
            Thumbnail(url: store.imageURL(for: item.images.first))
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(2)
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack {
                    StatusBadge(status: item.status)
                    Spacer(minLength: 8)
                    Text(priceText)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var meta: String {
        [item.brand, item.size, item.category]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private var priceText: String {
        var parts = ["EK \(item.purchasePrice.eurOrDash)"]
        if item.countsAsSale, let sold = item.soldPrice {
            parts.append("VK \(sold.eur)")
        } else if let listing = item.listingPrice {
            parts.append("Angebot \(listing.eur)")
        }
        return parts.joined(separator: " · ")
    }
}
