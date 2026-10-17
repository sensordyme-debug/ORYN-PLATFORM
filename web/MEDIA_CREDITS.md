# Media credits

All photography, footage, data, and typefaces used on the ORYN website, with sources and licenses. Licenses were verified on each source page at download time (2026-10-10). This list is also published on the site at `/credits`.

> Third-party aircraft that appear in photos represent the technology category and are captioned as such. They are not ORYN products. SensorDyme Aero is shown only as an ORYN-built concept model, never with stock photography.

## Licenses in use

- **Unsplash License**: free for commercial and non-commercial use; no permission or attribution required (attribution is provided anyway). No Unsplash+ content is used. <https://unsplash.com/license>
- **Mixkit Stock Video Free License**: free for commercial and personal projects. Only clips under this license are used. <https://mixkit.co/license/#videoFree>
- **U.S. Government works (USGS)**: public domain. <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits>
- **NASA Earthdata open data**: no restrictions on use. <https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-guidance>
- **SIL Open Font License 1.1**: Geist Sans and Geist Mono.

## Data and generated imagery

| Asset | Source | License | Notes |
| --- | --- | --- | --- |
| `public/media/map/basemap.webp`, `relief.webp`, `src/assets/usgs/*` | [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) (USGSImageryOnly, USGSShadedReliefOnly) | Public domain | Grant County, Washington (about 47.0–47.1°N, 119.8–120.1°W). |
| `public/media/map/contours.svg` | Computed from [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) elevation | Public domain | 20 m contours; `scripts/geo/map_layers.py`. |
| `public/media/map/analysis.webp`, `src/assets/intel/*-analysis.jpg`, `src/assets/usgs/system-seg.webp` | Derived by ORYN from the images listed here | Same as the source image | Illustrative outputs; `scripts/intel/analysis.py`. |
| `src/assets/intel/mead-2019.jpg`, `mead-2022.jpg`, `mead-change.jpg` | [NASA HLS](https://www.earthdata.nasa.gov/data/projects/hls) S30 via [NASA GIBS](https://gibs.earthdata.nasa.gov/) | NASA open data | 15 Jul 2019 and 19 Jul 2022; change map derived by ORYN; `scripts/intel/lake_mead.py`. |
| Typefaces | [Geist](https://vercel.com/font) by Vercel | SIL OFL 1.1 | Loaded with `next/font/google`. |
| ORYN logo | ORYN | Proprietary | Vector reconstruction of the supplied master artwork (`scripts/logo/`). |
| `src/assets/edge/*.png` | SensorDyme demo (`DemoSlideshow/assets/renders`) | Proprietary (ORYN) | Renders of the SensorDyme Edge prototype industrial design, generated from the demo's procedural 3D model. Internal components are third-party parts. |
| SensorDyme Aero 3D model | ORYN | Proprietary | Built in code (`src/components/aero/drone-model.ts`). Concept model; not finished hardware. |

## Photography and video

| File | Author | Source | License | Notes |
| --- | --- | --- | --- | --- |
| `src/assets/img/intel-agriculture.jpg` | [Bernd Dittrich](https://unsplash.com/@hdbernd) | [unsplash.com/photos/S-kKSx7shyU](https://unsplash.com/photos/S-kKSx7shyU) | Unsplash License |  |
| `src/assets/img/intel-construction.jpg` | [Shane McLendon](https://unsplash.com/@kctinman) | [unsplash.com/photos/EN1tF2EG-50](https://unsplash.com/photos/EN1tF2EG-50) | Unsplash License | Equipment bounding boxes hand-annotated for the detection demo. |
| `src/assets/img/intel-flood.jpg` | [Mathis Mauprivez](https://unsplash.com/@mathisvisuals) | [unsplash.com/photos/ldodZGd4MuA](https://unsplash.com/photos/ldodZGd4MuA) | Unsplash License | Oblique view; used for the segmentation demo. |
| `src/assets/img/intel-landcover.jpg` | [Bernd Dittrich](https://unsplash.com/@hdbernd) | [unsplash.com/photos/ELWXlqo_Sp8](https://unsplash.com/photos/ELWXlqo_Sp8) | Unsplash License |  |
| `src/assets/img/ind-agriculture.jpg` | [Bernd Dittrich](https://unsplash.com/@hdbernd) | [unsplash.com/photos/W1NsOMhU8hI](https://unsplash.com/photos/W1NsOMhU8hI) | Unsplash License |  |
| `src/assets/img/ind-environment.jpg` | [Ivars Utināns](https://unsplash.com/@ivoprod) | [unsplash.com/photos/vkQgb1lZZPQ](https://unsplash.com/photos/vkQgb1lZZPQ) | Unsplash License |  |
| `src/assets/img/ind-construction.jpg` | [Nabeel Hussain](https://unsplash.com/@nabeelhussainphotos) | [unsplash.com/photos/SJHvClnZnbw](https://unsplash.com/photos/SJHvClnZnbw) | Unsplash License |  |
| `src/assets/img/ind-disaster.jpg` | [Luke Miller](https://unsplash.com/@bylukemiller) | [unsplash.com/photos/hu1vOpNdsTI](https://unsplash.com/photos/hu1vOpNdsTI) | Unsplash License |  |
| `src/assets/img/ind-sar.jpg` | [Joshua Earle](https://unsplash.com/@joshuaearle) | [unsplash.com/photos/hfbreSmE3D8](https://unsplash.com/photos/hfbreSmE3D8) | Unsplash License |  |
| `src/assets/img/agriculture-2.jpg` | [Erik Fabian](https://unsplash.com/@fabianerik) | [unsplash.com/photos/cL7sTSHMjg4](https://unsplash.com/photos/cL7sTSHMjg4) | Unsplash License |  |
| `src/assets/img/environment-2.jpg` | [Cosmin Andrei Buzamat](https://unsplash.com/@cos592) | [unsplash.com/photos/mVNA-yH7wNM](https://unsplash.com/photos/mVNA-yH7wNM) | Unsplash License |  |
| `src/assets/img/construction-2.jpg` | [Built Robotics](https://unsplash.com/@built) | [unsplash.com/photos/oX2MggrtCVA](https://unsplash.com/photos/oX2MggrtCVA) | Unsplash License |  |
| `src/assets/img/disaster-2.jpg` | [Mathis Mauprivez](https://unsplash.com/@mathisvisuals) | [unsplash.com/photos/K9zAD3Ro5MY](https://unsplash.com/photos/K9zAD3Ro5MY) | Unsplash License |  |
| `src/assets/img/sar-2.jpg` | [Joss Woodhead](https://unsplash.com/@josswoodhead) | [unsplash.com/photos/53ZlFYkBavc](https://unsplash.com/photos/53ZlFYkBavc) | Unsplash License |  |
| `src/assets/img/about-earth.jpg` | [Dembee Tsogoo](https://unsplash.com/@tsdembee) | [unsplash.com/photos/zVNU8WC1ino](https://unsplash.com/photos/zVNU8WC1ino) | Unsplash License |  |
| `src/assets/img/about-workshop.jpg` | [ThisisEngineering](https://unsplash.com/@thisisengineering) | [unsplash.com/photos/LJGdVKuWmQM](https://unsplash.com/photos/LJGdVKuWmQM) | Unsplash License |  |
| `src/assets/img/tech-hero.jpg` | [Louei Mups](https://unsplash.com/@marlouei) | [unsplash.com/photos/EQESWJoLca0](https://unsplash.com/photos/EQESWJoLca0) | Unsplash License |  |
| `src/assets/img/step-request.jpg` | [Toni Reed](https://unsplash.com/@trfotos) | [unsplash.com/photos/dSjrv4w1g1Q](https://unsplash.com/photos/dSjrv4w1g1Q) | Unsplash License |  |
| `src/assets/img/step-deploy.jpg` | [Daniele Fiungo](https://unsplash.com/@danielefiungo) | [unsplash.com/photos/jb0NPAjhUWw](https://unsplash.com/photos/jb0NPAjhUWw) | Unsplash License | Yuneec Typhoon H hexacopter; representative. |
| `src/assets/img/step-analyze.jpg` | [Sou Jest](https://unsplash.com/@soujest) | [unsplash.com/photos/EBCVK7UUaNY](https://unsplash.com/photos/EBCVK7UUaNY) | Unsplash License |  |
| `src/assets/img/step-deliver.jpg` | [Tamas Pap](https://unsplash.com/@tamasp) | [unsplash.com/photos/5mb398I76Jo](https://unsplash.com/photos/5mb398I76Jo) | Unsplash License | Tablet shows third-party flight software; representative. |
| `src/assets/img/contact.jpg` | [Benni Talent](https://unsplash.com/@bennitalent) | [unsplash.com/photos/oc6fccnUVnA](https://unsplash.com/photos/oc6fccnUVnA) | Unsplash License |  |
| `public/media/video/hero.mp4` | [Marco López](https://mixkit.co/@marcolopez/) | [mixkit.co/free-stock-video/landscape-around-a-large-lake-from-above-5004/](https://mixkit.co/free-stock-video/landscape-around-a-large-lake-from-above-5004/) | Mixkit Stock Video Free License | Trimmed, scaled, re-encoded; 1.6 s crossfade for a seamless loop. |
| `public/media/video/hero-mobile.mp4` | [Marco López](https://mixkit.co/@marcolopez/) | [mixkit.co/free-stock-video/landscape-around-a-large-lake-from-above-5004/](https://mixkit.co/free-stock-video/landscape-around-a-large-lake-from-above-5004/) | Mixkit Stock Video Free License | 4:5 crop of the same clip; seamless loop. |
| `public/media/video/flyover.mp4` | [Marco López](https://mixkit.co/@marcolopez/) | [mixkit.co/free-stock-video/aerial-view-of-a-road-and-tree-tops-826/](https://mixkit.co/free-stock-video/aerial-view-of-a-road-and-tree-tops-826/) | Mixkit Stock Video Free License | Trimmed and re-encoded; poster frame extracted. |

Photos were resized and re-encoded. Some are darkened or toned with CSS where they appear; the files are otherwise unaltered.

## Adding media

1. Use only assets you have the rights to. Record the source page, author, and license in this file.
2. Put images in `src/assets/img/` and videos in `public/media/video/`.
3. Register the asset in `src/content/media.ts` (alt text, focal point, credit) and in `src/content/credits.ts`.
