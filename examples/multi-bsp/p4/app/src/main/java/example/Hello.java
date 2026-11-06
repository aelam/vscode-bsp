package example;

public final class Hello {
    public static String greet(String name) {
        String value = name.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("A name is required");
        }
        return "Hello, " + value + "!";
    }

    public static void main(String[] arguments) {
        System.out.println(greet(arguments.length == 0 ? "Gradle BSP" : arguments[0]));
    }
}
