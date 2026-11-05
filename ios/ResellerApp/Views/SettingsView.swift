import SwiftUI

struct SettingsView: View {
    @Environment(ItemStore.self) private var store
    @AppStorage("serverURL") private var serverURL = ""
    @State private var state: TestState = .idle

    private enum TestState {
        case idle, running, ok(Int), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.20:3000", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Verbindung testen") { Task { await test() } }
                        .disabled(serverURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    result
                } header: {
                    Text("Server")
                } footer: {
                    Text("Adresse deines Reseller-Dashboard-Servers. Unterwegs zuerst das VPN verbinden.")
                }

                Section("Info") {
                    LabeledContent("Version", value: versionText)
                }
            }
            .navigationTitle("Einstellungen")
        }
    }

    @ViewBuilder private var result: some View {
        switch state {
        case .idle:
            EmptyView()
        case .running:
            ProgressView()
        case .ok(let count):
            Label("Verbunden – \(count) Artikel gefunden", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed(let message):
            Label(message, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
        }
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }

    private func test() async {
        guard let url = APIClient.normalize(serverURL) else {
            state = .failed("Die Adresse ist ungültig. Beispiel: http://192.168.1.20:3000")
            return
        }
        state = .running
        do {
            let items = try await APIClient(baseURL: url).fetchItems()
            state = .ok(items.count)
            store.configure(serverURL: serverURL)
            await store.load()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
