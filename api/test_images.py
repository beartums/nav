import unittest

import images


class Images(unittest.TestCase):
    def test_types_are_known_by_their_bytes(self):
        self.assertEqual(images.sniff(b"\xff\xd8\xff\xe0rest"), "image/jpeg")
        self.assertEqual(images.sniff(b"\x89PNG\r\n\x1a\nrest"), "image/png")
        self.assertEqual(images.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp")
        self.assertEqual(images.sniff(b"GIF89a..."), "image/gif")
        self.assertIsNone(images.sniff(b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"))

    def test_check_refuses_empty_big_and_unknown(self):
        self.assertEqual(images.check(b"\x89PNG\r\n\x1a\n" + b"x" * 10), "image/png")
        for bad in (b"", b"<svg/>", b"\x89PNG\r\n\x1a\n" + b"x" * images.MAX_BYTES):
            with self.assertRaises(ValueError):
                images.check(bad)

    def test_the_name_is_the_hash(self):
        self.assertTrue(images.SHA.match(images.name(b"abc")))
        self.assertTrue(images.URL.match("api/images/" + images.name(b"abc")))
