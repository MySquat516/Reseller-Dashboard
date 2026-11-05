import SwiftUI

struct ItemDetailView: View {
    @Environment(ItemStore.self) private var store
    let item: Item
    var onDeleted: () -> Void

    @State private var showingEdit = false
    @State private var confirmDelete = false
    @State private var errorText: String?

    var body: some View {
        List {
            if let url = store.imageURL(for: item.images.first) {
                Section {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        case .failure:
                            Image(systemName: "photo").foregroundStyle(.secondary)
                        default:
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: 280)
                    .listRowInsets(EdgeInsets())
                    if item.images.count > 1 {
                        Text("\(item.images.count) Bilder").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Text(item.title).font(.title3.bold())
                LabeledContent("Status") { StatusBadge(status: item.status) }
                row("Größe", item.size)
                row("Kategorie", item.category)
                row("Marke", item.brand)
                row("Zustand", item.condition)
                if let text = item.description, !text.isEmpty {
                    Text(text).font(.callout)
                }
            }

            Section("Preise") {
                row("Einkaufspreis", item.purchasePrice?.eur)
                row("Gekauft am", DateCoding.displayText(item.purchaseDate))
                row("Einstellpreis", item.listingPrice?.eur)
                row("Online seit", DateCoding.displayText(item.listedDate))
                row("Verkaufspreis", item.soldPrice?.eur)
                row("Verkauft am", DateCoding.displayText(item.soldDate))
                row("Gebühren", item.fees.flatMap { $0 > 0 ? $0.eur : nil })
                row("Versandkosten", item.shippingCost.flatMap { $0 > 0 ? $0.eur : nil })
                if let profit = item.profit {
                    LabeledContent("Gewinn") {
                        Text(profit.eur).bold().foregroundStyle(profit >= 0 ? Color.green : Color.red)
                    }
                    row("Marge", item.margin?.percentText)
                }
            }

            if hasSaleDetails {
                Section("Verkauf") {
                    row("Plattform", item.platform)
                    row("Käufer", item.buyer)
                    row("Zahlungsart", item.paymentMethod)
                    row("Zahlungsstatus", item.paymentStatus?.capitalized)
                }
            }

            if hasShipping {
                Section("Versand") {
                    row("Anbieter", item.carrier)
                    row("Sendungsnummer", item.trackingNumber)
                    if let url = item.trackingURL {
                        Link("Sendung verfolgen", destination: url)
                    }
                }
            }

            if let notes = item.notes, !notes.isEmpty {
                Section("Notizen") { Text(notes) }
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Image(systemName: "trash")
                }
                .accessibilityLabel("Löschen")
                Button("Bearbeiten") { showingEdit = true }
            }
        }
        .sheet(isPresented: $showingEdit) {
            NavigationStack { ItemFormView(item: item) }
        }
        .confirmationDialog("Artikel löschen?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Löschen", role: .destructive) { Task { await delete() } }
        } message: {
            Text("„\(item.title)“ und seine Bilder werden auf dem Server gelöscht.")
        }
        .alert(
            "Fehler",
            isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorText ?? "")
        }
    }

    private var hasSaleDetails: Bool {
        [item.platform, item.buyer, item.paymentMethod].contains { !($0 ?? "").isEmpty } || item.soldPrice != nil
    }

    private var hasShipping: Bool {
        [item.carrier, item.trackingNumber].contains { !($0 ?? "").isEmpty }
    }

    @ViewBuilder private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            LabeledContent(label, value: value)
        }
    }

    private func delete() async {
        do {
            try await store.delete(id: item.id)
            onDeleted()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
