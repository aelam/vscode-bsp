import Foundation

enum Greeting {
    static func message(for name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Hello, \(trimmed.isEmpty ? "BSP" : trimmed)!"
    }
}
