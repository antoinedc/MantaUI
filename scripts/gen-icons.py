from PIL import Image
import os

SRC = "docs/brand/manta-mark.png"
im = Image.open(SRC).convert("RGBA")
im = im.crop(im.getbbox())  # tight crop to visible mark

def square(mark, size, pad_frac=0.14, bg=None):
    """Center mark on a square canvas of `size`, mark occupies (1-2*pad_frac)."""
    canvas = Image.new("RGBA", (size, size), (0,0,0,0) if bg is None else bg)
    inner = int(size * (1 - 2*pad_frac))
    w,h = mark.size
    scale = min(inner/w, inner/h)
    nw,nh = max(1,int(w*scale)), max(1,int(h*scale))
    m = mark.resize((nw,nh), Image.LANCZOS)
    canvas.alpha_composite(m, ((size-nw)//2, (size-nh)//2))
    return canvas

NAVY = (11,16,32,255)  # #0B1020

# ---- transparent square master ----
os.makedirs("docs/brand", exist_ok=True)
square(im, 1024).save("docs/brand/manta-mark-square.png")

# ---- PWA / web (transparent) ----
os.makedirs("src/renderer/public/icons", exist_ok=True)
square(im, 180).save("src/renderer/public/icons/icon-180.png")
# 512 keeps ~18% safe zone for maskable
square(im, 512, pad_frac=0.18).save("src/renderer/public/icons/icon-512.png")

# ---- favicon (transparent, small) ----
square(im, 64).save("docs/brand/manta-favicon-64.png")
square(im, 32).save("docs/brand/manta-favicon-32.png")

# ---- iOS AppIcon 1024 (NAVY bg — iOS forbids alpha on the app icon) ----
p="mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
if os.path.isdir(os.path.dirname(p)):
    square(im, 1024, bg=NAVY).save(p)

# ---- Capacitor master (1024, navy so generated icons have no alpha) ----
if os.path.isdir("mobile/assets"):
    square(im, 1024, bg=NAVY).save("mobile/assets/icon.png")

# ---- Android mipmaps ----
dens = {"ldpi":36,"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}
for d,sz in dens.items():
    base=f"mobile/android/app/src/main/res/mipmap-{d}"
    if not os.path.isdir(base): continue
    # legacy square icon on navy
    square(im, sz, bg=NAVY).save(f"{base}/ic_launcher.png")
    # round: same art (Android masks it)
    square(im, sz, bg=NAVY).save(f"{base}/ic_launcher_round.png")
    # adaptive foreground: transparent, mark smaller (safe zone ~ 33%)
    square(im, sz, pad_frac=0.28).save(f"{base}/ic_launcher_foreground.png")
    # adaptive background: solid navy
    Image.new("RGBA",(sz,sz),NAVY).save(f"{base}/ic_launcher_background.png")

print("generated:")
for root in ["docs/brand","src/renderer/public/icons","mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset","mobile/assets"]:
    if os.path.isdir(root):
        for f in sorted(os.listdir(root)):
            if f.endswith(".png"):
                pth=os.path.join(root,f); print(f"  {pth} {Image.open(pth).size}")

# ---- Splash images (mark on navy) ----
import glob
def splash(w,h):
    c=Image.new("RGBA",(w,h),NAVY)
    inner=int(min(w,h)*0.32)
    mw,mh=im.size; s=min(inner/mw,inner/mh); nw,nh=int(mw*s),int(mh*s)
    m=im.resize((nw,nh),Image.LANCZOS)
    c.alpha_composite(m,((w-nw)//2,(h-nh)//2))
    return c.convert("RGB")
for f in glob.glob("mobile/ios/App/App/Assets.xcassets/Splash.imageset/*.png"):
    sz=Image.open(f).size; splash(*sz).save(f)
for f in glob.glob("mobile/android/app/src/main/res/drawable*/splash.png"):
    sz=Image.open(f).size; splash(*sz).save(f)
print("splashes regenerated")
