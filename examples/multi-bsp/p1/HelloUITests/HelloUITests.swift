import XCTest

final class HelloUITests: XCTestCase {
    @MainActor
    func testLaunchShowsGreeting() {
        let app = XCUIApplication()
        app.launch()
        let greeting = app.staticTexts["greeting"]
        XCTAssertTrue(greeting.waitForExistence(timeout: 10))
        XCTAssertEqual(greeting.label, "Hello, BSP!")
    }
}
