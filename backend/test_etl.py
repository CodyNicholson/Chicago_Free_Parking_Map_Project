import unittest
from backend.chicago_parking_etl import (
    ALL_FREE_MASK,
    TOTAL_WEEKLY_SLOTS,
    build_bitmask_from_restriction,
    combine_restriction_masks,
    generate_chicago_curb_dataset,
    int_mask_to_bitstring,
    int_mask_to_hex,
    offset_linestring_coords,
    parse_schedule_text_to_bitmask,
)


def decode_hex_to_bits(hex_str: str) -> list[int]:
    """Mirrors the frontend Uint8Array(672) decoder for cross-tier verification."""
    assert len(hex_str) == 168
    bits: list[int] = []
    for ch in hex_str:
        nibble = int(ch, 16)
        bits.append((nibble >> 3) & 1)
        bits.append((nibble >> 2) & 1)
        bits.append((nibble >> 1) & 1)
        bits.append(nibble & 1)
    return bits


class TestChicagoParkingETL(unittest.TestCase):
    def test_all_free_mask_format(self):
        bit_str = int_mask_to_bitstring(ALL_FREE_MASK)
        hex_str = int_mask_to_hex(ALL_FREE_MASK)
        self.assertEqual(len(bit_str), TOTAL_WEEKLY_SLOTS)
        self.assertEqual(bit_str, "1" * 672)
        self.assertEqual(len(hex_str), 168)
        self.assertEqual(hex_str, "f" * 168)

    def test_same_day_restriction_window(self):
        # Restrict Monday (day=1) from 8:00 AM (slot 32) to 10:00 PM (slot 88)
        mask = build_bitmask_from_restriction([1], 8, 0, 22, 0)
        hex_str = int_mask_to_hex(mask)
        bits = decode_hex_to_bits(hex_str)

        # Sunday (day=0) should be completely free
        for s in range(96):
            self.assertEqual(bits[0 * 96 + s], 1)

        # Monday 7:45 AM (slot 31) is free, 8:00 AM (slot 32) is restricted,
        # 9:45 PM (slot 87) is restricted, 10:00 PM (slot 88) is free
        self.assertEqual(bits[1 * 96 + 31], 1)
        self.assertEqual(bits[1 * 96 + 32], 0)
        self.assertEqual(bits[1 * 96 + 87], 0)
        self.assertEqual(bits[1 * 96 + 88], 1)

    def test_overnight_wrap_around_restriction(self):
        # Restrict Saturday night (day=6) from 6:00 PM (slot 72) to 6:00 AM Sunday (day=0, slot 24)
        mask = build_bitmask_from_restriction([6], 18, 0, 6, 0)
        bits = decode_hex_to_bits(int_mask_to_hex(mask))

        # Saturday 5:45 PM (slot 71) -> Free (1)
        self.assertEqual(bits[6 * 96 + 71], 1)
        # Saturday 6:00 PM (slot 72) .. 11:45 PM (slot 95) -> Restricted (0)
        for s in range(72, 96):
            self.assertEqual(bits[6 * 96 + s], 0)

        # Sunday 12:00 AM (slot 0) .. 5:45 AM (slot 23) -> Restricted (0)
        for s in range(0, 24):
            self.assertEqual(bits[0 * 96 + s], 0)
        # Sunday 6:00 AM (slot 24) -> Free (1)
        self.assertEqual(bits[0 * 96 + 24], 1)

    def test_parse_schedule_text_and_combine(self):
        mask = parse_schedule_text_to_bitmask("MON-FRI 7:00 AM - 9:00 AM, 4:00 PM - 6:00 PM")
        bits = decode_hex_to_bits(int_mask_to_hex(mask))

        # Tuesday (day=2): 7:00 AM (slot 28) restricted, 9:00 AM (slot 36) free, 4:00 PM (slot 64) restricted
        self.assertEqual(bits[2 * 96 + 27], 1)
        self.assertEqual(bits[2 * 96 + 28], 0)
        self.assertEqual(bits[2 * 96 + 36], 1)
        self.assertEqual(bits[2 * 96 + 64], 0)
        self.assertEqual(bits[2 * 96 + 72], 1)

    def test_curb_offset_geometry_and_dataset_generation(self):
        centerline = [[-87.7068, 41.9248], [-87.7068, 41.9280]]
        left_curb = offset_linestring_coords(centerline, "L", offset_meters=6.5)
        right_curb = offset_linestring_coords(centerline, "R", offset_meters=6.5)

        # Heading North: Left curb is West (more negative lng), Right curb is East (less negative lng)
        self.assertLess(left_curb[0][0], centerline[0][0])
        self.assertGreater(right_curb[0][0], centerline[0][0])

        dataset = generate_chicago_curb_dataset()
        self.assertGreater(len(dataset["features"]), 400)
        sample_props = dataset["features"][0]["properties"]
        self.assertEqual(len(sample_props["mask_hex"]), 168)
        self.assertIn(sample_props["side"], ("L", "R"))
        self.assertIn(sample_props["parity"], ("O", "E"))


if __name__ == "__main__":
    unittest.main()
