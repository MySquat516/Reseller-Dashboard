import SwiftUI

struct RootView: View {
    private enum Tab: Hashable {
        case items, dashboard, settings
    }

    /// Ohne Serveradresse startet die App direkt in den Einstellungen.
    @State private var tab: Tab = (UserDefaults.standard.string(forKey: "serverURL") ?? "").isEmpty ? .settings : .items

    var body: some View {
        TabView(selection: $tab) {
            ItemsView()
                .tabItem { Label("Artikel", systemImage: "shippingbox") }
                .tag(Tab.items)

            NavigationStack {
                ContentUnavailableView(
                    "Dashboard folgt",
                    systemImage: "chart.bar",
                    description: Text("Kommt in der nächsten Phase.")
                )
                .navigationTitle("Dashboard")
            }
            .tabItem { Label("Dashboard", systemImage: "chart.bar") }
            .tag(Tab.dashboard)

            SettingsView()
                .tabItem { Label("Einstellungen", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
    }
}
