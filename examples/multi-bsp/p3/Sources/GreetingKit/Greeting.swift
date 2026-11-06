import Foundation

public func greeting(for name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return "Hello, \(trimmed.isEmpty ? "BSP" : trimmed)!"
}
