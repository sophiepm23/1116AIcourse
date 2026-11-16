"""用程式畫一張寫實風的鍋貼插畫（非照片）。輸出 icons/potsticker-source.jpg"""
import numpy as np, os
from PIL import Image, ImageFilter

N = 1024
rng = np.random.default_rng(7)
ss = lambda a, b, x: (lambda t: t*t*(3-2*t))(np.clip((x-a)/(b-a), 0, 1))

_f = np.fft.fftfreq(N).astype('float32')
_FR2 = _f[:, None]**2 + _f[None, :]**2

def blur(a, s):
    """FFT 高斯模糊（環狀邊界）"""
    return np.fft.ifft2(np.fft.fft2(a) * np.exp(-2*(np.pi*s)**2 * _FR2)).real.astype('float32')

def noise(sigma, amp=1.0):
    n = blur(rng.standard_normal((N, N)).astype('float32'), sigma)
    return ((n - n.mean()) / (n.std() + 1e-6) * amp).astype('float32')

yy, xx = np.mgrid[0:N, 0:N].astype('float32')

def dumpling(cx, cy, ang, A, B):
    """回傳 (mask, height, v_norm, pleat) — 新月形、上緣有褶子"""
    c, s = np.cos(ang), np.sin(ang)
    u = ((xx-cx)*c + (yy-cy)*s) / A
    v = (-(xx-cx)*s + (yy-cy)*c) / B
    t = np.arctan2(v, u)
    r = np.sqrt(u*u + v*v)
    top = v > 0
    pl = np.sin(t * 17 + 0.4)            # 褶子
    edge_r = 1 + np.where(top, 0.035*pl, 0)
    inner = (r < edge_r)
    # 下緣：略微內凹的接合線（新月）
    seam = -0.45 + 0.55*u*u
    m = inner & (v > seam)
    mask = m.astype('float32')
    mask = blur(mask, 2.0)
    body = blur(m.astype('float32'), 55)
    h = np.clip(body*1.5, 0, 1) ** 0.8
    # 褶子隆起
    band = np.exp(-(((1-r)/0.17)**2)) * top * ss(0.0, 0.25, v)
    ridge = (0.5 + 0.5*pl) ** 1.5
    h = h + 0.28 * band * ridge
    return mask, h, v, band * ridge

# ---- 背景：深色鐵鍋 + 暖光 + 油光 ----
cxy = np.hypot(xx-N/2, yy-N/2) / (N/2)
bg = np.zeros((N, N, 3), 'float32')
base = 0.16 + 0.10*np.exp(-(cxy/0.9)**2)
tex = 0.012*noise(1.2) + 0.02*noise(25)
for k, w in enumerate((1.0, 0.92, 0.85)):
    bg[..., k] = (base*w + tex)
bg[..., 0] += 0.05*np.exp(-(cxy/0.7)**2)
bg *= (1 - 0.45*np.clip(cxy-0.55, 0, 1))[..., None]
# 零星油光點
spark = (blur((rng.random((N, N)) > 0.99995).astype('float32'), 4) * 400).clip(0, 1)
pass  # 省略油光點

# ---- 鍋貼（兩顆，一大一小，前後疊放）----
specs = [(600, 400, np.deg2rad(-24), 235, 195), (440, 625, np.deg2rad(12), 305, 240)]
img = bg.copy()
L = np.array([-0.55, -0.65, 0.52]); L /= np.linalg.norm(L)
Hv = L + np.array([0, 0, 1.0]); Hv /= np.linalg.norm(Hv)

for cx, cy, ang, A, B in specs:
    mask, h, v, pl = dumpling(cx, cy, ang, A, B)
    # 投影
    sh = blur(np.roll(np.roll(mask, 26, 0), 22, 1), 22) * 0.75
    img *= (1 - sh)[..., None]
    # 顏色：上緣偏奶油麵皮，其餘金黃煎色 + 焦斑
    gold = np.array([0.80, 0.50, 0.17]); cream = np.array([0.93, 0.80, 0.52]); brown = np.array([0.45, 0.22, 0.06])
    cream_w = ss(0.15, 0.85, v) * 0.85 + pl*0.25
    col = gold[None, None] * (1 - cream_w[..., None]) + cream[None, None] * cream_w[..., None]
    spots = ss(0.35, 1.3, noise(9) * 0.8 + noise(3) * 0.4 + 0.1)
    streak = ss(0.2, 1.4, noise(14, 1.0) )
    burn = np.clip(spots*0.5 + streak*0.25, 0, 1) * (1 - 0.65*cream_w)
    col = col * (1 - burn[..., None]) + brown[None, None] * burn[..., None]
    col *= (1 + 0.05*noise(1.0))[..., None]
    # 光照
    gy, gx = np.gradient(blur(h, 1.6))
    k = 38
    nx, ny, nz = -gx*k, -gy*k, np.ones_like(h)
    nrm = np.sqrt(nx**2 + ny**2 + nz**2); nx, ny, nz = nx/nrm, ny/nrm, nz/nrm
    diff = np.clip(nx*L[0] + ny*L[1] + nz*L[2], 0, 1)
    spec = np.clip(nx*Hv[0] + ny*Hv[1] + nz*Hv[2], 0, 1) ** 45
    gloss = 0.35 + 0.65*ss(0.2, 1.2, noise(6)*0.6 + 0.8)       # 油亮不均
    ao = 0.55 + 0.45*np.clip(h*1.4, 0, 1)
    lit = col * (0.12 + 1.15*diff)[..., None] * ao[..., None]
    lit += (spec * gloss * 0.75)[..., None] * np.array([1.0, 0.93, 0.8])
    # 邊緣暖色反光
    rim = blur(mask, 6) - blur(mask, 14)
    lit += np.clip(rim, 0, 1)[..., None] * np.array([0.5, 0.3, 0.1]) * 0.6
    m3 = mask[..., None]
    img = img*(1-m3) + np.clip(lit, 0, 1)*m3

# 撒點蔥花
for _ in range(7):
    x, y = rng.integers(120, N-120, 2); a = rng.uniform(0, np.pi); l = rng.uniform(10, 22)
    d = np.abs((xx-x)*np.sin(a) - (yy-y)*np.cos(a)); al = np.abs((xx-x)*np.cos(a) + (yy-y)*np.sin(a))
    m = ((d < 4) & (al < l)).astype('float32'); m = blur(m, 1.2)[..., None]
    img = img*(1-m*0.9) + np.array([0.35, 0.62, 0.2])*m*0.9

# 暗角與微顆粒
img *= (1 - 0.35*np.clip(cxy-0.7, 0, 1)**1.5)[..., None]
img += (rng.standard_normal((N, N, 1)) * 0.008)
out = Image.fromarray((np.clip(img, 0, 1)**(1/1.05) * 255).astype('uint8'))
dst = os.path.join(os.path.dirname(__file__), '..', 'icons', 'potsticker-source.jpg')
out.save(dst, quality=93); print('wrote', dst)
