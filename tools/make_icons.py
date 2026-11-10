# Generates the app icons (run by the bootstrap workflow).
from PIL import Image, ImageDraw, ImageFont
import glob, os
fp = [p for p in glob.glob('/usr/share/fonts/**/*.ttf', recursive=True) if p.endswith('DejaVuSans-Bold.ttf')][0]
INK = (20, 22, 26); LIME = (201, 242, 75)
os.makedirs('icons', exist_ok=True)
def make(size, path, maskable=False):
    S = size * 4
    im = Image.new('RGB', (S, S), INK); d = ImageDraw.Draw(im)
    pad = S * 0.22 if maskable else S * 0.14
    a, b = pad, S - pad; L = (b - a) * 0.26; w = int(S * 0.045)
    for (x, y, dx, dy) in [(a, a, 1, 1), (b, a, -1, 1), (a, b, 1, -1), (b, b, -1, -1)]:
        d.line([(x, y), (x + dx * L, y)], fill=LIME, width=w); d.line([(x, y), (x, y + dy * L)], fill=LIME, width=w)
        r = w / 2; d.ellipse([x - r, y - r, x + r, y + r], fill=LIME)
    f = ImageFont.truetype(fp, int((b - a) * 0.52))
    t = '74'; bb = d.textbbox((0, 0), t, font=f)
    d.text(((S - (bb[2] - bb[0])) / 2 - bb[0], (S - (bb[3] - bb[1])) / 2 - bb[1]), t, font=f, fill=(244, 245, 240))
    im.resize((size, size), Image.LANCZOS).save(path)
make(192, 'icons/icon-192.png'); make(512, 'icons/icon-512.png'); make(512, 'icons/maskable-512.png', True)
make(180, 'icons/apple-180.png'); make(64, 'icons/fav-64.png')
