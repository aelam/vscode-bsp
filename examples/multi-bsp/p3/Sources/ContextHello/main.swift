import GreetingKit

#if DEBUG
let configuration = "debug"
#else
let configuration = "release"
#endif

let name = CommandLine.arguments.dropFirst().first ?? "BSP"
print("\(greeting(for: name)) [\(configuration)]")
