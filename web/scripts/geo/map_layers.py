"""
Build the ORYN Command preview map layers from public-domain USGS data.

Inputs (produced by stitch.py and the 3DEP request below):
  out/quincy14.jpg         USGSImageryOnly, zoom 14, 12x8 tiles around 47.05N, -119.93W
  out/quincy14_relief.jpg  USGSShadedReliefOnly, same extent
  out/dem.tif              3DEP elevation (F32), same extent, Web Mercator

3DEP request (bbox in EPSG:3857 matching the stitched tiles):
  https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage
    ?bbox=<xmin,ymin,xmax,ymax>&bboxSR=3857&imageSR=3857&size=1536,1024
    &format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image

Outputs -> public/media/map/: basemap.webp, relief.webp, analysis.webp, contours.svg

Usage: python3 map_layers.py <work_dir> <repo_root>
Requires: numpy, pillow, scipy, matplotlib
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

work, repo = sys.argv[1], sys.argv[2]
OUT = f"{repo}/public/media/map"
W, H = 2560, 1707

img = Image.open(f"{work}/out/quincy14.jpg").convert("RGB")
base = img.resize((W, H), Image.LANCZOS)
base.save(f"{OUT}/basemap.webp", "WEBP", quality=74, method=6)
Image.open(f"{work}/out/quincy14_relief.jpg").convert("L").resize((W, H), Image.LANCZOS).save(
    f"{OUT}/relief.webp", "WEBP", quality=72, method=6
)

# Analysis layer: Excess Green index + simple water mask, at half resolution.
small = img.resize((1280, 854), Image.LANCZOS)
a = np.asarray(small).astype(np.float32)
s = a.sum(axis=2) + 1e-6
exg = ndimage.gaussian_filter(2 * a[..., 1] / s - a[..., 0] / s - a[..., 2] / s, 1.0)
lum = a.mean(axis=2)
water = (lum < 75) & (a[..., 2] > a[..., 1] * 1.02) & (a[..., 2] > a[..., 0] * 1.05)
water = ndimage.binary_closing(ndimage.binary_opening(water, iterations=2), iterations=2)
lab, n = ndimage.label(water)
sizes = ndimage.sum(water, lab, range(1, n + 1))
water = np.isin(lab, np.where(sizes > 40)[0] + 1)
lo, hi = np.percentile(exg, [45, 99.5])
t = np.clip((exg - lo) / (hi - lo), 0, 1)
stops = np.array(
    [[0.0, 70, 52, 30, 0], [0.12, 196, 140, 60, 70], [0.4, 233, 185, 73, 165], [0.72, 141, 191, 99, 190], [1.0, 205, 238, 145, 210]],
    np.float32,
)
out = np.zeros(a.shape[:2] + (4,), np.float32)
for c in range(4):
    out[..., c] = np.interp(t, stops[:, 0], stops[:, c + 1])
out[water] = [95, 180, 214, 165]
Image.fromarray(out.astype(np.uint8), "RGBA").save(f"{OUT}/analysis.webp", "WEBP", quality=62, method=6)

# Contours: 20 m interval, 100 m index contours, simplified with Ramer–Douglas–Peucker.
dem = ndimage.gaussian_filter(np.array(Image.open(f"{work}/out/dem.tif")).astype(np.float32), 2.0)
sx, sy = W / dem.shape[1], H / dem.shape[0]
cs = plt.figure().add_subplot().contour(dem, levels=np.arange(180, 720, 20))


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        p, q = pts[i], pts[j]
        seg = q - p
        L = np.hypot(*seg)
        sub = pts[i + 1 : j]
        d = np.abs(seg[0] * (sub[:, 1] - p[1]) - seg[1] * (sub[:, 0] - p[0])) / L if L > 0 else np.hypot(*(sub - p).T)
        k = int(np.argmax(d))
        if d[k] > eps:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return pts[keep]


paths = {"minor": [], "major": []}
for lev, segs in zip(cs.levels, cs.allsegs):
    kind = "major" if int(lev) % 100 == 0 else "minor"
    for seg in segs:
        if len(seg) < 6:
            continue
        pts = rdp(np.c_[seg[:, 0] * sx, seg[:, 1] * sy], 1.6)
        if len(pts) >= 3:
            paths[kind].append("M" + " ".join(f"{x:.0f} {y:.0f}" for x, y in pts))

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" fill="none" stroke-linejoin="round">\n'
    f'<g stroke="#F2F1ED" stroke-opacity="0.22" stroke-width="1.4"><path d="{" ".join(paths["minor"])}"/></g>\n'
    f'<g stroke="#F2F1ED" stroke-opacity="0.5" stroke-width="2.4"><path d="{" ".join(paths["major"])}"/></g>\n</svg>'
)
open(f"{OUT}/contours.svg", "w").write(svg)
print("done")
