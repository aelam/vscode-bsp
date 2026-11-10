package example.bspandroid;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class GreetingTest {
    @Test
    public void saysHello() {
        assertEquals("Hello from Gradle BSP", Greeting.message());
    }
}
