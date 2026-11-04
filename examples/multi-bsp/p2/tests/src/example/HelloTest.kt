package example

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class HelloTest {
    @Test
    fun greetsByName() {
        assertEquals("Hello, BSP!", greeting("BSP"))
    }

    @Test
    fun trimsWhitespace() {
        assertEquals("Hello, Kotlin!", greeting("  Kotlin  "))
    }

    @Test
    fun rejectsEmptyNames() {
        assertThrows(IllegalArgumentException::class.java) { greeting(" ") }
    }

    @Test
    fun reportsOptionalFailure() {
        assertFalse(
            javaClass.getResource("/fail-test.txt") != null,
            "Intentional BSP test failure. Remove tests/resources/fail-test.txt to restore passing tests.",
        )
    }
}
