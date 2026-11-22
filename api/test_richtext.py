"""richtext.py: what a text block may keep."""
import unittest

import richtext


class Clean(unittest.TestCase):
    def test_keeps_formatting(self):
        html = ('<h2 style="text-align: center">Hi</h2><p><b>bold</b> <i>it</i> <u>u</u> '
                '<span style="color: #c00; font-size: 18px">red</span></p><ul><li>one</li></ul>')
        self.assertEqual(richtext.clean(html), html)

    def test_drops_danger(self):
        out = richtext.clean('<p onclick="x()">a<script>alert(1)</script></p>'
                             '<a href="javascript:alert(1)">l</a><img src="http://x/i.png">'
                             '<span style="background: url(x); color: red">c</span><iframe src="x">in</iframe>')
        self.assertEqual(out, '<p>a</p><a target="_blank" rel="noopener noreferrer">l</a><span style="color: red">c</span>')

    def test_links_and_images(self):
        self.assertIn('href="https://example.com"', richtext.clean('<a href="https://example.com">x</a>'))
        self.assertIn('src="api/images/' + 'a' * 64 + '"', richtext.clean('<img src="api/images/' + 'a' * 64 + '">'))

    def test_nesting_is_repaired_and_text_escaped(self):
        self.assertEqual(richtext.clean('<p><b>x</p>1 < 2'), '<p><b>x</b></p>1 &lt; 2')

    def test_too_long(self):
        with self.assertRaises(ValueError):
            richtext.clean('x' * (richtext.MAX_LEN + 1))


if __name__ == "__main__":
    unittest.main()
