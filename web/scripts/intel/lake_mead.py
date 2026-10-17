"""
Temporal change example: Lake Mead (Boulder Basin), July 2019 vs July 2022.

Imagery: NASA Harmonized Landsat Sentinel-2 (HLS S30) via NASA GIBS WMS (open data).

  curl -o mead_2019-07-15.jpg "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=HLS_S30_Nadir_BRDF_Adjusted_Reflectance&STYLES=&CRS=EPSG:4326&BBOX=36.0,-114.85,36.2,-114.55&WIDTH=1200&HEIGHT=989&FORMAT=image/jpeg&TIME=2019-07-15"
  (repeat with TIME=2022-07-19)

Water is segmented with simple RGB thresholds; areas use the pixel footprint of
the requested bounding box. Results are approximate and for illustration only.

Usage: python3 lake_mead.py <work_dir> <repo_root>
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

work, repo = sys.argv[1], sys.argv[2]


def water(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = a.mean(2)
    m = ((g - r) > 4) & (lum < 150) | ((b - r) > 2) & (lum < 120)
    m = ndimage.binary_closing(ndimage.binary_opening(m, iterations=1), iterations=2)
    lab, n = ndimage.label(m)
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    return np.isin(lab, np.where(sizes > 300)[0] + 1), a


w19, a19 = water(f"{work}/mead_2019-07-15.jpg")
w22, a22 = water(f"{work}/mead_2022-07-19.jpg")
lost = ndimage.binary_opening(w19 & ~w22, iterations=1)
keep = w19 & w22

px_m2 = (0.30 * 111.32 * np.cos(np.radians(36.1)) * 1000 / 1200) * (0.20 * 110.95 * 1000 / 989)
km2 = lambda m: float(m.sum() * px_m2 / 1e6)  # noqa: E731
stats = {"water2019": km2(w19), "water2022": km2(w22), "lost": km2(lost), "pctLost": 100 * km2(lost) / km2(w19)}

g = a22.mean(2, keepdims=True)
out = (a22 * 0.35 + g * 0.65) * 0.55
out[keep] = out[keep] * 0.4 + np.array([95, 180, 214]) * 0.48
out[lost] = out[lost] * 0.15 + np.array([233, 185, 73]) * 0.85
out[lost ^ ndimage.binary_erosion(lost)] = [255, 220, 140]

O = f"{repo}/src/assets/intel/"
Image.fromarray(a19.astype(np.uint8)).save(O + "mead-2019.jpg", quality=86, optimize=True)
Image.fromarray(a22.astype(np.uint8)).save(O + "mead-2022.jpg", quality=86, optimize=True)
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(O + "mead-change.jpg", quality=86, optimize=True)
print(json.dumps({k: round(v, 1) for k, v in stats.items()}))
