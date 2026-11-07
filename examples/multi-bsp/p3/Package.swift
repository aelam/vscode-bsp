// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ContextDemo",
    products: [
        .library(name: "GreetingKit", targets: ["GreetingKit"]),
        .executable(name: "hello-context", targets: ["ContextHello"]),
    ],
    targets: [
        .target(name: "GreetingKit"),
        .executableTarget(name: "ContextHello", dependencies: ["GreetingKit"]),
        .testTarget(name: "GreetingKitTests", dependencies: ["GreetingKit"]),
    ]
)
