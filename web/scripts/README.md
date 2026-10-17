# Asset scripts

One-off Python scripts used to produce the site's generated assets. They are not
part of the Next.js build and do not need to be run to develop or deploy the site
— their outputs are committed. They are kept so every generated asset is
reproducible and its method is documented.

Requirements: Python 3.10+, `numpy`, `pillow`, `scipy`, `matplotlib`; `potrace` is
not required (the logo is reconstructed geometrically).

| Script | Produces | Method |
| --- | --- | --- |
| `logo/build_logo.py` | `src/components/brand/logo.tsx` paths, `public/brand/*.svg` | The master ORYN logo was measured edge-by-edge at sub-pixel precision; straight edges were fit as lines and corners rebuilt as circular fillets / elliptical arcs so the mark renders crisply at any size. Proportions match the original artwork. |
| `geo/stitch.py`, `geo/region.py` | Raw USGS tile mosaics | Fetches USGS The National Map tiles (public domain) for a lat/lon window. |
| `geo/map_layers.py` | `public/media/map/*` | Basemap and relief exports; vegetation index (ExG) analysis layer; contour lines computed from USGS 3DEP elevation (20 m interval). |
| `intel/analysis.py` | `src/assets/intel/*-analysis.jpg` | ExG vegetation index (agriculture); k-means color clustering with spatial rules (flood, land cover); toned base for hand-annotated detections (construction). |
| `intel/lake_mead.py` | `src/assets/intel/mead-*.jpg` | NASA HLS imagery for two dates; RGB water masks; change map; approximate areas from pixel footprint. |

All "analysis" outputs are illustrations of the interface and techniques. They are
not results of ORYN's production models and make no claim about model accuracy.
