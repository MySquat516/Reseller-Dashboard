import SwiftUI

/// Liste links, Details rechts (iPad). Auf dem iPhone wird daraus automatisch eine Navigation mit Zurück-Taste.
struct ItemsView: View {
    @Environment(ItemStore.self) private var store
    @State private var selection: Int?
    @State private var search = ""
    @State private var filter: ItemFilter = .active
    @State private var showingNew = false
    @State private var itemToDelete: Item?

    private var visibleItems: [Item] {
        store.items.filter { filter.matches($0) && $0.matches(search: search) }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .task(id: store.configurationID) {
            await store.load()
        }
        .sheet(isPresented: $showingNew) {
            NavigationStack { ItemFormView(item: nil) }
        }
        .confirmationDialog(
            "Artikel löschen?",
            isPresented: Binding(get: { itemToDelete != nil }, set: { if !$0 { itemToDelete = nil } }),
            titleVisibility: .visible,
            presenting: itemToDelete
        ) { item in
            Button("„\(item.title)“ löschen", role: .destructive) {
                Task { await delete(item) }
            }
        } message: { _ in
            Text("Der Artikel und seine Bilder werden auf dem Server gelöscht.")
        }
    }

    // MARK: Liste

    private var sidebar: some View {
        List(visibleItems, selection: $selection) { item in
            ItemRow(item: item)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        itemToDelete = item
                    } label: {
                        Label("Löschen", systemImage: "trash")
                    }
                }
        }
        .navigationTitle("Artikel")
        .searchable(text: $search, prompt: "Titel, Marke, Kategorie …")
        .refreshable { await store.load() }
        .overlay { emptyState }
        .safeAreaInset(edge: .top) { errorBanner }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { filterMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNew = true
                } label: {
                    Label("Neuer Artikel", systemImage: "plus")
                }
            }
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Status", selection: $filter) {
                ForEach(ItemFilter.options, id: \.self) { option in
                    Text(option.label).tag(option)
                }
            }
        } label: {
            Label(filter.label, systemImage: "line.3.horizontal.decrease.circle")
        }
    }

    @ViewBuilder private var emptyState: some View {
        if store.isLoading && store.items.isEmpty {
            ProgressView("Lade …")
        } else if store.items.isEmpty && store.errorMessage == nil {
            ContentUnavailableView(
                "Noch keine Artikel",
                systemImage: "shippingbox",
                description: Text("Lege mit dem Plus-Symbol den ersten Artikel an.")
            )
        } else if visibleItems.isEmpty && !store.items.isEmpty {
            ContentUnavailableView(
                "Keine Treffer",
                systemImage: "magnifyingglass",
                description: Text("Passe Suche oder Filter an.")
            )
        }
    }

    @ViewBuilder private var errorBanner: some View {
        if let message = store.errorMessage {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(message).font(.footnote)
                Spacer(minLength: 0)
                Button("Erneut") { Task { await store.load() } }
                    .font(.footnote.bold())
                    .buttonStyle(.plain)
                    .underline()
            }
            .padding(10)
            .foregroundStyle(.white)
            .background(Color.red.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .padding(.top, 4)
        }
    }

    // MARK: Details

    @ViewBuilder private var detail: some View {
        if let id = selection, let item = store.items.first(where: { $0.id == id }) {
            ItemDetailView(item: item) { selection = nil }
        } else {
            ContentUnavailableView(
                "Kein Artikel gewählt",
                systemImage: "shippingbox",
                description: Text("Wähle links einen Artikel aus.")
            )
        }
    }

    private func delete(_ item: Item) async {
        do {
            try await store.delete(id: item.id)
            if selection == item.id { selection = nil }
        } catch {
            store.errorMessage = error.localizedDescription
        }
    }
}
