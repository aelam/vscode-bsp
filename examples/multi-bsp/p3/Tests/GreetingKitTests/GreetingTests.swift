import GreetingKit
import XCTest

final class GreetingTests: XCTestCase {
    func testNamedGreeting() {
        XCTAssertEqual(greeting(for: "SwiftPM"), "Hello, SwiftPM!")
    }

    func testTrimsWhitespace() {
        XCTAssertEqual(greeting(for: "  Kotlin\n"), "Hello, Kotlin!")
    }

    func testEmptyNameUsesDefault() {
        XCTAssertEqual(greeting(for: " \n "), "Hello, BSP!")
    }
}
