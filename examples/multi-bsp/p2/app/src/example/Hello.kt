package example

fun greeting(name: String): String {
    require(name.isNotBlank()) { "A name is required" }
    return "Hello, ${name.trim()}!"
}

fun main(args: Array<String>) {
    println(greeting(args.firstOrNull() ?: "BSP"))
}
