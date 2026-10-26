import SwiftUI

/// Formular zum Anlegen (`item == nil`) und Bearbeiten. Bilder folgen in Phase 3.
struct ItemFormView: View {
    @Environment(ItemStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private let itemID: Int?
    @State private var draft: ItemDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(item: Item?) {
        itemID = item?.id
        _draft = State(initialValue: ItemDraft(item: item))
    }

    private var conditionOptions: [String] {
        var options = ["Neu mit Etikett", "Neu", "Sehr gut", "Gut", "Zufriedenstellend"]
        if !draft.condition.isEmpty && !options.contains(draft.condition) {
            options.insert(draft.condition, at: 0)
        }
        return options
    }

    var body: some View {
        Form {
            Section("Artikel") {
                TextField("Titel", text: $draft.title)
                TextField("Beschreibung", text: $draft.description, axis: .vertical)
                    .lineLimit(2...6)
                TextField("Größe", text: $draft.size)
                TextField("Kategorie", text: $draft.category)
                TextField("Marke", text: $draft.brand)
                Picker("Zustand", selection: $draft.condition) {
                    Text("–").tag("")
                    ForEach(conditionOptions, id: \.self) { Text($0).tag($0) }
                }
            }

            Section("Status") {
                Picker("Status", selection: $draft.status) {
                    ForEach(ItemStatus.allCases) { Text($0.label).tag($0) }
                }
            }

            Section("Preise") {
                moneyField("Einkaufspreis", $draft.purchasePrice)
                OptionalDateField(title: "Gekauft am", date: $draft.purchaseDate)
                moneyField("Einstellpreis", $draft.listingPrice)
                OptionalDateField(title: "Online seit", date: $draft.listedDate)
                moneyField("Verkaufspreis", $draft.soldPrice)
                OptionalDateField(title: "Verkauft am", date: $draft.soldDate)
            }

            if draft.soldBeforeListed || draft.hasInvalidNumbers {
                Section {
                    if draft.soldBeforeListed {
                        Label(
                            "„Verkauft am“ liegt vor „Online seit“. Speichern klappt, aber die Standzeit wird für diesen Artikel nicht berechnet.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    }
                    if draft.hasInvalidNumbers {
                        Label("Mindestens ein Preisfeld enthält keine gültige Zahl.", systemImage: "xmark.octagon")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }

            Section("Verkauf") {
                TextField("Plattform (Vinted, eBay …)", text: $draft.platform)
                TextField("Käufer", text: $draft.buyer)
                TextField("Zahlungsart (PayPal, Überweisung …)", text: $draft.paymentMethod)
                Picker("Zahlungsstatus", selection: $draft.paymentStatus) {
                    Text("Offen").tag("offen")
                    Text("Bezahlt").tag("bezahlt")
                }
                .pickerStyle(.segmented)
            }

            Section("Kosten") {
                moneyField("Gebühren", $draft.fees)
                moneyField("Versandkosten", $draft.shippingCost)
            }

            Section("Versand") {
                TextField("Versandanbieter (DHL, Hermes …)", text: $draft.carrier)
                TextField("Sendungsnummer", text: $draft.trackingNumber)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            Section("Notizen") {
                TextField("Notizen", text: $draft.notes, axis: .vertical)
                    .lineLimit(2...6)
            }

            if let profit = draft.profit {
                Section("Ergebnis") {
                    LabeledContent("Gewinn") {
                        Text(profit.eur).bold().foregroundStyle(profit >= 0 ? Color.green : Color.red)
                    }
                    if let margin = draft.margin {
                        LabeledContent("Marge", value: margin.percentText)
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(itemID == nil ? "Neuer Artikel" : "Bearbeiten")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: draft.soldPrice) { _, _ in
            draft.applySoldPriceRule()
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Speichern") { Task { await save() } }
                        .disabled(!draft.canSave)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .alert(
            "Speichern fehlgeschlagen",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func moneyField(_ title: String, _ text: Binding<String>) -> some View {
        LabeledContent(title) {
            HStack(spacing: 4) {
                TextField("0,00", text: text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                Text("€").foregroundStyle(.secondary)
            }
            .frame(maxWidth: 160)
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await store.save(id: itemID, input: draft.makeInput())
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
