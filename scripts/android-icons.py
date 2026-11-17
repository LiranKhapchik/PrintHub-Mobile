"""Writes PrintHub launcher icons into the generated Android project (legacy + adaptive)."""
import os
import re
import sys

from PIL import Image

res = sys.argv[1] if len(sys.argv) > 1 else "android/app/src/main/res"
full = Image.open("icons/icon-512.png").convert("RGBA")
mask = Image.open("icons/icon-maskable-512.png").convert("RGBA")
legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for d, px in legacy.items():
    folder = os.path.join(res, f"mipmap-{d}")
    os.makedirs(folder, exist_ok=True)
    full.resize((px, px), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
    full.resize((px, px), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_round.png"))
    # adaptive foreground: 108dp canvas, artwork inside the 72dp safe zone
    fg = px * 108 // 48
    canvas = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
    art = mask.resize((fg, fg), Image.LANCZOS)
    canvas.paste(art, (0, 0), art)
    canvas.save(os.path.join(folder, "ic_launcher_foreground.png"))
bg = os.path.join(res, "values", "ic_launcher_background.xml")
if os.path.exists(bg):
    s = open(bg, encoding="utf-8").read()
    s = re.sub(r"#[0-9A-Fa-f]{6,8}", "#2F5BD3", s)
    open(bg, "w", encoding="utf-8").write(s)
print("icons written to", res)
