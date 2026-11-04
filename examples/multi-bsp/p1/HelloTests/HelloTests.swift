import Testing
@testable import Hello

struct HelloTests {
    @Test
    func greetsByName() {
        #expect(Greeting.message(for: "Swift") == "Hello, Swift!")
    }

    @Test
    func trimsWhitespace() {
        print("Trimming whitespace test")
        #expect(Greeting.message(for: "  Xcode  ") == "Hello, Xcode!")
    }

    @Test
    func usesDefaultName() {
        #expect(Greeting.message(for: " ") == "Hello, BSP!")
    }
}
