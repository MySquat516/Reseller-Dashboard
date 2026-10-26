import SwiftUI

@main
struct ResellerAppMain: App {
    @State private var store = ItemStore()
    @AppStorage("serverURL") private var serverURL = ""

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .onChange(of: serverURL, initial: true) { _, newValue in
                    store.configure(serverURL: newValue)
                }
        }
    }
}
