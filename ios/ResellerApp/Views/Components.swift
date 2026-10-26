import SwiftUI

struct StatusBadge: View {
    let status: ItemStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(status.color)
            .overlay(
                Capsule().strokeBorder(
                    status.color,
                    style: StrokeStyle(lineWidth: 1, dash: status == .zuVersenden ? [3, 2] : [])
                )
            )
    }
}

struct Thumbnail: View {
    let url: URL?
    var size: CGFloat = 60

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        placeholder
                    default:
                        ProgressView()
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var placeholder: some View {
        Image(systemName: "photo").foregroundStyle(.secondary)
    }
}

/// Optionales Datum: „Setzen“ legt heute an, das Kreuz entfernt es wieder.
struct OptionalDateField: View {
    let title: String
    @Binding var date: Date?

    var body: some View {
        if let current = date {
            HStack {
                DatePicker(
                    title,
                    selection: Binding(get: { current }, set: { date = $0 }),
                    displayedComponents: .date
                )
                Button {
                    date = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(title) entfernen")
            }
        } else {
            Button {
                date = Date()
            } label: {
                LabeledContent(title) {
                    Text("Setzen").foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.primary)
        }
    }
}
