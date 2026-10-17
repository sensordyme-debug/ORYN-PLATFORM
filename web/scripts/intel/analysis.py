"""
Generate the illustrative ORYN Intelligence outputs from the licensed sample photos.

  agriculture-analysis.jpg  Excess Green (ExG) vegetation index, 4-class ramp
  flood-analysis.jpg        k-means (Lab, k=6) clusters -> water mask + boundary
  landcover-analysis.jpg    k-means (Lab, k=7) clusters + spatial rules -> 5 classes
  construction-analysis.jpg Toned base image; boxes are hand-annotated in
                            src/content/intelligence.ts

Cluster-to-class assignments were chosen by inspecting cluster colors and
positions for these specific images (see comments). Percentages printed at the
end are the pixel fractions used in src/content/intelligence.ts.

Usage: python3 analysis.py <repo_root>
Requires: numpy, pillow, scipy
"""
import json
import sys

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
from scipy.cluster.vq import kmeans2

repo = sys.argv[1]
A = f"{repo}/src/assets/img/"
O = f"{repo}/src/assets/intel/"
W = 2048
stats = {}


def hexrgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], np.float32)


def rgb2lab(a):
    a = a / 255.0
    a = np.where(a > 0.04045, ((a + 0.055) / 1.055) ** 2.4, a / 12.92)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = a @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def clusters(name, k):
    im = Image.open(A + name).convert("RGB")
    sm = im.resize((im.width // 4, im.height // 4), Image.LANCZOS)
    lab = rgb2lab(ndimage.gaussian_filter(np.asarray(sm).astype(np.float32), (1.5, 1.5, 0)))
    _, lbl = kmeans2(lab.reshape(-1, 3), k, minit="++", seed=7)
    return lbl.reshape(lab.shape[:2])


def majority(lbl, n, size):
    return np.stack([ndimage.uniform_filter((lbl == i).astype(np.float32), size) for i in range(n)], 0).argmax(0)


def tone(im, dark=0.45, gray=0.6):
    a = np.asarray(im).astype(np.float32)
    return (a * (1 - gray) + a.mean(2, keepdims=True) * gray) * dark


def upscale(lbl, size, mult):
    up = np.array(Image.fromarray(lbl.astype(np.uint8)).resize(size, Image.NEAREST))
    return np.array(Image.fromarray((up * mult).astype(np.uint8)).filter(ImageFilter.ModeFilter(7))) // mult


def load(name):
    im = Image.open(A + name).convert("RGB")
    return im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)


def save(arr, name):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(O + name, quality=84, optimize=True, progressive=True)


# Agriculture — ExG
im = load("intel-agriculture.jpg")
a = np.asarray(im).astype(np.float32)
s = a.sum(2) + 1e-6
exg = ndimage.gaussian_filter(2 * a[..., 1] / s - a[..., 0] / s - a[..., 2] / s, 2.0)
lo, hi = np.percentile(exg, [3, 99])
t = np.clip((exg - lo) / (hi - lo), 0, 1)
stops = [(0.0, "#7a4a2a"), (0.22, "#c48c3c"), (0.42, "#e9b949"), (0.62, "#a8c95f"), (0.82, "#6fae4f"), (1.0, "#cdee91")]
cols = np.array([hexrgb(c) for _, c in stops])
ramp = np.stack([np.interp(t, [p for p, _ in stops], cols[:, c]) for c in range(3)], -1)
save(tone(im, 0.3, 0.8) * 0.35 + ramp * 0.82, "agriculture-analysis.jpg")
stats["agriculture"] = {
    "High vigor": (t >= 0.66).mean(),
    "Moderate": ((t >= 0.42) & (t < 0.66)).mean(),
    "Low vigor": ((t >= 0.22) & (t < 0.42)).mean(),
    "Bare / sparse": (t < 0.22).mean(),
}

# Flood — clusters 1, 3, 4 are water; cluster 0 in the bottom band is brown floodwater; 2 is pasture.
im = load("intel-flood.jpg")
lbl = clusters("intel-flood.jpg", 6)
h, w = lbl.shape
yy = np.mgrid[0:h, 0:w][0]
cls = np.full(lbl.shape, 1)
cls[np.isin(lbl, [1, 3, 4])] = 0
cls[(lbl == 0) & (yy > 0.72 * h)] = 0
cls[lbl == 2] = 2
CL = upscale(majority(cls, 3, 5), im.size, 80)
water = CL == 0
edge = water ^ ndimage.binary_erosion(water, iterations=3)
out = tone(im, 0.55, 0.7)
out[water] = out[water] * 0.35 + hexrgb("#5fb4d6") * 0.55
out[edge] = [205, 240, 250]
save(out, "flood-analysis.jpg")
stats["flood"] = {"Water (segmented)": water.mean(), "Trees & hedgerows": (CL == 1).mean(), "Dry pasture": (CL == 2).mean()}

# Land cover — classes: 0 water, 1 cropland, 2 trees/grass, 3 bare soil, 4 built (x in source pixels).
im = load("intel-landcover.jpg")
lbl = clusters("intel-landcover.jpg", 7)
h, w = lbl.shape
xx = np.mgrid[0:h, 0:w][1] * (2560 / w)
c = np.full(lbl.shape, 2)
c[lbl == 2] = 0
c[np.isin(lbl, [1, 3]) & (xx < 800)] = 1
c[(lbl == 3) & (xx >= 800)] = 2
c[np.isin(lbl, [5, 6])] = 2
c[(lbl == 0) & (xx < 900)] = 3
c[np.isin(lbl, [0, 4]) & (xx >= 900)] = 4
c[(lbl == 4) & (xx < 900)] = 3
wm = c == 0
lab, n = ndimage.label(wm)
sizes = ndimage.sum(wm, lab, range(1, n + 1))
c[wm & ~np.isin(lab, np.where(sizes >= sizes.max() * 0.2)[0] + 1)] = 4
CL = upscale(majority(c, 5, 5), im.size, 50)
pal = {0: "#5fb4d6", 1: "#e9b949", 2: "#8dbf63", 3: "#c08a5a", 4: "#a39be0"}
out = tone(im, 0.5, 0.85)
for k, hx in pal.items():
    m = CL == k
    out[m] = out[m] * 0.32 + hexrgb(hx) * 0.68
bd = np.zeros(CL.shape, bool)
bd[:-1] |= CL[:-1] != CL[1:]
bd[:, :-1] |= CL[:, :-1] != CL[:, 1:]
bd = ndimage.binary_dilation(bd, iterations=1)
out[bd] = out[bd] * 0.4 + np.array([10, 11, 12]) * 0.6
save(out, "landcover-analysis.jpg")
names = {0: "Water", 1: "Cropland", 2: "Trees & grass", 3: "Bare soil", 4: "Built surface"}
stats["landcover"] = {names[k]: (CL == k).mean() for k in names}

# Construction — toned base only.
im = load("intel-construction.jpg")
save(tone(im, 0.62, 0.85) + np.array([0, 4, 10], np.float32), "construction-analysis.jpg")

print(json.dumps({k: {n: round(float(v) * 100, 1) for n, v in d.items()} for k, d in stats.items()}, indent=1))
