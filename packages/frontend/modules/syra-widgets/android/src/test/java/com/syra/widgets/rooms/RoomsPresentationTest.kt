package com.syra.widgets.rooms

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

/**
 * The listener count as it is drawn. Pure arithmetic and formatting, so it needs
 * no device — but it DOES depend on the device's locale, which is the part most
 * likely to be wrong and least likely to be noticed by whoever wrote it in
 * English.
 */
class RoomsPresentationTest {

    private val original: Locale = Locale.getDefault()

    @After
    fun restoreLocale() {
        Locale.setDefault(original)
    }

    @Test
    fun `counts below a thousand are drawn as they are`() {
        Locale.setDefault(Locale.US)
        assertEquals("0", formatCompactCount(0))
        assertEquals("1", formatCompactCount(1))
        assertEquals("999", formatCompactCount(999))
    }

    @Test
    fun `thousands and millions get one decimal, and lose it when whole`() {
        Locale.setDefault(Locale.US)
        assertEquals("1K", formatCompactCount(1_000))
        assertEquals("1.2K", formatCompactCount(1_240))
        assertEquals("9.9K", formatCompactCount(9_900))
        assertEquals("1M", formatCompactCount(1_000_000))
        assertEquals("2.5M", formatCompactCount(2_500_000))
    }

    @Test
    fun `a locale that writes a decimal comma gets a comma`() {
        // es and it are two of the three locales this module ships strings in, so
        // a US-formatted number would sit inside otherwise-translated text.
        for (locale in listOf(Locale.forLanguageTag("es-ES"), Locale.ITALY)) {
            Locale.setDefault(locale)
            assertEquals("$locale should use a decimal comma", "1,2K", formatCompactCount(1_240))
        }
    }

    @Test
    fun `a whole number loses its decimal in every locale, not just English`() {
        // The trap that makes the locale-correct version wrong: stripping a
        // literal ".0" suffix matches nothing once the formatter emits "1,0",
        // so an es device would read "1,0K" where en reads "1K".
        for (locale in listOf(Locale.US, Locale.forLanguageTag("es-ES"), Locale.ITALY)) {
            Locale.setDefault(locale)
            assertEquals("$locale should drop a zero fraction", "1K", formatCompactCount(1_000))
            assertEquals("$locale should drop a zero fraction", "3M", formatCompactCount(3_000_000))
        }
    }

    @Test
    fun `a fraction that rounds away is dropped, not drawn as a zero`() {
        Locale.setDefault(Locale.US)
        // 1040 / 1000 = 1.04, which formats to "1.0" — it has to come out as "1".
        assertEquals("1K", formatCompactCount(1_040))
    }
}
