package example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

final class HelloTest {
    @Test
    void greetsByName() {
        assertEquals("Hello, Gradle!", Hello.greet("Gradle"));
    }

    @Test
    void trimsWhitespace() {
        assertEquals("Hello, Java!", Hello.greet("  Java\n"));
    }

    @Test
    void rejectsEmptyNames() {
        assertThrows(IllegalArgumentException.class, () -> Hello.greet(" \n "));
    }
}
