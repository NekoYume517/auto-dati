"""生成 AutoDati 图标（16/32/48/128）。

设计：圆角方 + 靛蓝→紫罗兰渐变 + 白色「答」字 + 右下角对勾徽章。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "extension", "icons")
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyhbd.ttf",
]

def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

C1 = (79, 70, 229)    # indigo-600
C2 = (139, 92, 246)   # violet-500
C3 = (56, 189, 248)   # sky-400

def gradient(size, with_badge):
    img = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    S = size * 4
    # 对角渐变
    for i in range(S * 2):
        t = i / (S * 2 - 1)
        col = lerp(C1, C2, t) if t < 0.6 else lerp(C2, C3, (t - 0.6) / 0.4)
        d.line([(0, S - 1 - i), (i, S - 1)], fill=col + (255,), width=2)
    for i in range(S * 2):
        t = i / (S * 2 - 1)
        col = lerp(C1, C2, t) if t < 0.6 else lerp(C2, C3, (t - 0.6) / 0.4)
        d.line([(i, 0), (S - 1, S - 1 - i)], fill=col + (255,), width=2)

    # 圆角遮罩
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    radius = int(S * 0.24)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)

    # 顶部高光
    gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([-S * 0.3, -S * 0.75, S * 1.3, S * 0.42], fill=(255, 255, 255, 26))
    out = Image.alpha_composite(out, Image.composite(gloss, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

    # 「答」字
    font = pick_font(int(S * 0.58))
    d2 = ImageDraw.Draw(out)
    bbox = d2.textbbox((0, 0), "答", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = S / 2 - tw / 2 - bbox[0]
    cy = S * 0.40 - th / 2 - bbox[1]
    d2.text((cx, cy), "答", font=font, fill=(255, 255, 255, 250))

    if with_badge:
        # 右下角对勾徽章
        r = S * 0.235
        bx, by = S * 0.755, S * 0.775
        d2.ellipse([bx - r, by - r, bx + r, by + r], fill=(16, 185, 129, 255))
        lw = max(2, int(S * 0.045))
        d2.line([(bx - r * 0.52, by + r * 0.02), (bx - r * 0.1, by + r * 0.45)],
                fill=(255, 255, 255, 255), width=lw, joint="curve")
        d2.line([(bx - r * 0.1, by + r * 0.45), (bx + r * 0.58, by - r * 0.42)],
                fill=(255, 255, 255, 255), width=lw, joint="curve")

    return out.resize((size, size), Image.LANCZOS)

for s in (16, 32, 48, 128):
    img = gradient(s, with_badge=(s >= 32))
    img.save(os.path.join(OUT, "icon%d.png" % s))
    print("wrote", os.path.join(OUT, "icon%d.png" % s))