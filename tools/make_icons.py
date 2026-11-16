"""把一張真實鍋貼照片 (png/jpg) 做成發光 PWA icon。
用法: python3 tools/make_icons.py icons/potsticker-source.jpg
沒給照片時，會用程式畫一個暫代圖（placeholder），之後請換成真實照片重跑。"""
import sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG_TOP, BG_BOT = (58, 38, 25), (28, 17, 10)   # 與網站 wood 色系一致
GLOW = (255, 170, 70)

def background(n):
    y = np.linspace(0, 1, n)[:, None, None]
    a, b = np.array(BG_TOP), np.array(BG_BOT)
    arr = (a + (b - a) * y) * np.ones((1, n, 1))
    return Image.fromarray(arr.astype('uint8'), 'RGB').convert('RGBA')

def placeholder(n):
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.ellipse([0, n*.25, n, n*.9], fill=(222, 160, 70, 255))
    d.ellipse([n*.08, n*.3, n*.92, n*.8], fill=(240, 190, 100, 255))
    return im

def subject(src, n):
    if src:
        im = Image.open(src).convert('RGB'); s = min(im.size)
        l, t = (im.width - s)//2, (im.height - s)//2
        im = im.crop((l, t, l+s, t+s)).resize((n, n), Image.LANCZOS).convert('RGBA')
        m = Image.new('L', (n, n), 0)
        ImageDraw.Draw(m).ellipse([0, 0, n-1, n-1], fill=255)
        m = m.filter(ImageFilter.GaussianBlur(n*.01))
        im.putalpha(m); return im
    return placeholder(n)

def make(src, size, maskable):
    S = size * 2  # supersample
    base = background(S)
    inner = int(S * (0.56 if maskable else 0.66))   # maskable 需落在 80% 安全區內
    sub = subject(src, inner)
    pos = ((S - inner)//2, (S - inner)//2)
    alpha = sub.split()[3]
    # 發光：兩層模糊的暖橙色光暈
    for radius, strength in ((S*.09, .85), (S*.035, .9)):
        halo = Image.new('L', (S, S), 0); halo.paste(alpha, pos)
        halo = halo.filter(ImageFilter.GaussianBlur(radius))
        halo = halo.point(lambda v: int(min(255, v*strength*1.6)))
        base = Image.composite(Image.new('RGBA', (S, S), GLOW + (255,)), base, halo)
    base.alpha_composite(sub, pos)
    if not maskable:  # any 版本做圓角
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S-1, S-1], radius=int(S*.22), fill=255)
        base.putalpha(m)
    else:
        base = base.convert('RGB')
    return base.resize((size, size), Image.LANCZOS)

if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else None
    for name, size, mk in (('icon-192.png',192,False),('icon-512.png',512,False),
                           ('icon-maskable-512.png',512,True),('apple-touch-icon.png',180,True)):
        make(src, size, mk).save(os.path.join(OUT, name), optimize=True)
        print('wrote', name)
