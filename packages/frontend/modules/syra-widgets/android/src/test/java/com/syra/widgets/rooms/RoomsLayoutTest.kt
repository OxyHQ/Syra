package com.syra.widgets.rooms

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The breakpoint arithmetic, checked at the declared placement sizes AND at
 * sizes no breakpoint declares — `SizeMode.Exact` hands over whatever the host
 * reports, so a size nobody wrote down is the normal case, not the edge case.
 */
class RoomsLayoutTest {

    @Test
    fun `the default placement holds the title bar and two rooms`() {
        // 4 × 3 cells = 250 × 180dp, the size declared in dimens.xml/integers.xml.
        assertTrue(showTitleBar(180.dp))
        assertEquals(2, roomRowsThatFit(180.dp, showTitleBar = true))
        assertFalse(isCompact(250.dp))
    }

    @Test
    fun `the smallest resize still draws one room`() {
        // 2 × 1 cells = 110 × 40dp. Below the title bar threshold, and too short
        // for a full row — but a widget that fits nothing still has to draw
        // something, so the count floors at one rather than at zero.
        assertFalse(showTitleBar(40.dp))
        assertEquals(1, roomRowsThatFit(40.dp, showTitleBar = false))
        assertTrue(isCompact(110.dp))
    }

    @Test
    fun `row count never exceeds what is stored`() {
        // Otherwise a tall widget reserves height for rows that can never have
        // content, and the list ends in blank space.
        assertEquals(MAX_STORED_ROOMS, roomRowsThatFit(2000.dp, showTitleBar = false))
        assertTrue(roomRowsThatFit(320.dp, showTitleBar = true) <= MAX_STORED_ROOMS)
    }

    @Test
    fun `the stored cap covers the largest declared size, without being dead capacity`() {
        // Both directions, because each fails differently and silently:
        //
        //  - too SMALL and a widget resized to its declared maximum draws blank
        //    rows it has no data for;
        //  - too LARGE and every device fetches and persists rooms that nothing
        //    can ever display.
        //
        // 320dp is `syra_live_rooms_widget_max_resize_height`. The upper bound is
        // loose because `maxResizeHeight` is advisory and a launcher may exceed
        // it — but not unbounded, which is what caught the original value of 8.
        val rowsAtDeclaredMax = roomRowsThatFit(320.dp, showTitleBar = true)
        assertTrue(
            "the cap ($MAX_STORED_ROOMS) cannot fill the largest declared size ($rowsAtDeclaredMax rows)",
            MAX_STORED_ROOMS >= rowsAtDeclaredMax,
        )
        assertTrue(
            "the cap ($MAX_STORED_ROOMS) is far beyond the $rowsAtDeclaredMax rows the largest declared size draws",
            MAX_STORED_ROOMS <= rowsAtDeclaredMax * 2,
        )
    }

    @Test
    fun `row count is monotonic in height`() {
        // A widget made taller must never show FEWER rooms. This is the property
        // most likely to break if the chrome arithmetic is edited, and the least
        // likely to be noticed by eye at any single size.
        var previous = 0
        var height = 40
        while (height <= 400) {
            val rows = roomRowsThatFit(height.dp, showTitleBar = showTitleBar(height.dp))
            assertTrue(
                "height ${height}dp gave $rows rows, fewer than the $previous at a smaller height",
                rows >= previous || showTitleBar(height.dp) != showTitleBar((height - 4).dp),
            )
            previous = rows
            height += 4
        }
        // Vacuity floor: the loop must actually have reached the cap, or it
        // proved monotonicity over a range where nothing changed.
        assertEquals(MAX_STORED_ROOMS, previous)
    }

    @Test
    fun `the title bar costs height, so it never increases the row count`() {
        for (height in listOf(180, 220, 260, 300, 320)) {
            assertTrue(
                "at ${height}dp the title bar somehow allowed more rows",
                roomRowsThatFit(height.dp, showTitleBar = true) <=
                    roomRowsThatFit(height.dp, showTitleBar = false),
            )
        }
    }

    @Test
    fun `every row keeps a full touch target`() {
        // The count is derived by dividing by ROW_HEIGHT, so this asserts the
        // divisor is still Material's 48dp minimum rather than a number that was
        // shrunk to fit one more row in.
        assertTrue(RoomsWidgetDimensions.ROW_HEIGHT >= 48.dp)
    }

    @Test
    fun `the compact threshold sits below the default placement width`() {
        // Otherwise the widget ships compact at its own default size.
        assertTrue(RoomsWidgetDimensions.COMPACT_MAX_WIDTH < 250.dp)
        assertFalse(isCompact(RoomsWidgetDimensions.COMPACT_MAX_WIDTH))
        assertTrue(isCompact(RoomsWidgetDimensions.COMPACT_MAX_WIDTH - 1.dp))
    }
}
