"""
LiDAR roof cross-check — the third teammate.

POST /measure  { "lat": 27.11958, "lng": -82.44559, "pitch": 4 }
  -> { ok, status, squares, footprint_sqft, npts, seethrough, blob, ept }

It pulls a 64 m box of USGS 3DEP LiDAR (free public data) around the point via PDAL,
classifies ground vs. above-ground, and isolates the ROOF using two physical facts a
satellite can't see:
  • ground OCCLUSION — a solid roof blocks the laser from reaching the ground beneath
    it, while a screen cage / thin foliage lets the laser through to the ground. So a
    cell that has roof-height points AND ground points below it is NOT roof (cage/tree).
  • PLANARITY — a roof plane is smooth (low residual to a fitted plane); tree canopy is
    rough. Cells above the planarity threshold are dropped.
Then it takes the roof blob nearest the pin, triangulates its points into a footprint,
and applies the slope factor for the given pitch. Calibration (×1.05) and the trim
constants were validated against 183 Roofr ground-truth roofs.

This is the SAME pipeline proven in the batch test — just wrapped as an HTTP service so
the live tool can call it per address and fuse its vote with Solar + County records.
"""
import json, math, os, re, subprocess, tempfile
import numpy as np
from scipy import ndimage
from scipy.spatial import Delaunay
from shapely.geometry import shape, Point
from shapely import Polygon as SPoly
from shapely.ops import unary_union
from flask import Flask, request, jsonify

HERE = os.path.dirname(os.path.abspath(__file__))
SQFT = 10.7639          # sq ft per sq meter
CELL = 1.0              # raster cell size (m)
RESID = 0.7             # planarity residual cutoff (m): roof < this, tree canopy > this
H = 32                  # half-box (m) — pull a 64 m square around the pin
CAL = 1.05              # calibration vs Roofr ground truth
R = 20037508.342789244  # web-mercator half-circumference
PDAL = os.environ.get("PDAL_BIN", "pdal")


def to3857(lng, lat):
    return (lng / 180 * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi * R)


# ── EPT coverage index (which USGS 3DEP project covers a point). Loaded once at boot.
def _yr(n):
    m = re.findall(r"(20\d\d)", n)
    return max(int(x) for x in m) if m else 0


with open(os.path.join(HERE, "resources.geojson")) as f:
    _gj = json.load(f)
FEATS = []
for _f in _gj["features"]:
    nm = _f["properties"].get("name", "")
    try:
        g = shape(_f["geometry"])
        FEATS.append((nm, g, g.bounds, _yr(nm)))
    except Exception:
        pass
print(f"[lidar] loaded {len(FEATS)} EPT projects", flush=True)


def ept_for(lat, lng):
    hits = [(nm, y) for (nm, g, b, y) in FEATS
            if b[0] <= lng <= b[2] and b[1] <= lat <= b[3] and g.contains(Point(lng, lat))]
    if not hits:
        return None
    hits.sort(key=lambda t: -t[1])   # newest survey wins
    return hits[0][0]


def pull(lat, lng, ept, out):
    x, y = to3857(lng, lat)
    pipe = {"pipeline": [
        {"type": "readers.ept",
         "filename": f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{ept}/ept.json",
         "bounds": f"([{x - H},{x + H}],[{y - H},{y + H}])"},
        {"type": "filters.smrf"},
        {"type": "filters.hag_nn"},
        {"type": "writers.text", "filename": out,
         "order": "X,Y,Z,HeightAboveGround", "keep_unspecified": "false"},
    ]}
    with open(out + ".json", "w") as f:
        f.write(json.dumps(pipe))
    try:
        r = subprocess.run([PDAL, "pipeline", out + ".json"],
                           capture_output=True, text=True, timeout=180)
        return r.returncode == 0 and os.path.exists(out)
    except Exception:
        return False


def trim(csv, pitch12):
    d = np.loadtxt(csv, delimiter=",", skiprows=1)
    if d.ndim < 2 or len(d) < 60:
        return None
    X, Y, Z, HAG = d[:, 0], d[:, 1], d[:, 2], d[:, 3]
    x0, y0 = X.min(), Y.min()
    nx = int((X.max() - x0) / CELL) + 1
    ny = int((Y.max() - y0) / CELL) + 1
    cp = {}
    nh = np.zeros((ny, nx))
    ng = np.zeros((ny, nx))
    for x, y, z, h in zip(X, Y, Z, HAG):
        j = int((x - x0) / CELL)
        i = int((y - y0) / CELL)
        if h > 2.5:
            nh[i, j] += 1
            cp.setdefault((i, j), []).append((x, y, z))
        elif h < 0.5:
            ng[i, j] += 1
    resid = np.full((ny, nx), 9.9)
    for (i, j) in cp:
        P = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                P += cp.get((i + di, j + dj), [])
        if len(P) < 6:
            continue
        P = np.array(P)
        c = P.mean(0)
        A = np.c_[P[:, 0] - c[0], P[:, 1] - c[1], np.ones(len(P))]
        co, _, _, _ = np.linalg.lstsq(A, P[:, 2] - c[2], rcond=None)
        resid[i, j] = np.std(P[:, 2] - c[2] - A @ co)
    # solid roof: roof-height points, NO ground beneath (occlusion), and planar
    solid = (nh >= 1) & (ng <= 0) & (resid < RESID)
    ci, cj = ny // 2, nx // 2
    lbl, n = ndimage.label(solid)
    best, bd = None, 1e18
    for k in range(1, n + 1):
        ys, xs = np.where(lbl == k)
        if len(ys) < 15:
            continue
        dc = ((ys.mean() - ci) ** 2 + (xs.mean() - cj) ** 2) ** 0.5
        if dc < bd:
            bd, best = dc, k
    if not best:
        return None
    tgt = ndimage.binary_fill_holes(lbl == best)
    pts = np.array([(p[0], p[1]) for (i, j), P in cp.items() if tgt[i, j] for p in P])
    if len(pts) < 10:
        return None
    tri = Delaunay(pts)
    pl = []
    for s in tri.simplices:
        a, b, c = pts[s]
        e = max(np.hypot(*(a - b)), np.hypot(*(b - c)), np.hypot(*(c - a)))
        if e < 3.0:
            pl.append(SPoly([a, b, c]))
    fp = unary_union(pl).area * SQFT
    # see-through ratio near the building (cage / foliage indicator)
    near = ndimage.binary_dilation(tgt, iterations=2)
    seethru = ((nh >= 1) & (ng >= 1) & near).sum()
    solidc = int(tgt.sum())
    stratio = seethru / max(seethru + solidc, 1)
    sf = math.sqrt(1 + (pitch12 / 12) ** 2)
    return dict(fp=fp, sq=fp * sf / 100, npts=int((nh >= 1).sum()),
                stratio=stratio, blob=solidc)


app = Flask(__name__)


@app.route("/health")
def health():
    return "ok", 200


@app.route("/measure", methods=["POST"])
def measure():
    b = request.get_json(force=True, silent=True) or {}
    try:
        lat = float(b.get("lat"))
        lng = float(b.get("lng"))
    except Exception:
        return jsonify(ok=False, status="bad_input", error="lat/lng required"), 400
    try:
        pitch = float(b.get("pitch"))
    except Exception:
        pitch = 4.0
    ept = ept_for(lat, lng)
    if not ept:
        return jsonify(ok=False, status="no_ept", error="no LiDAR coverage here")
    fd, out = tempfile.mkstemp(suffix=".csv", dir="/tmp")
    os.close(fd)
    try:
        if not pull(lat, lng, ept, out):
            return jsonify(ok=False, status="no_lidar", ept=ept, error="LiDAR pull failed")
        r = trim(out, pitch)
        if not r:
            return jsonify(ok=False, status="no_roof", ept=ept, error="could not isolate a roof")
        return jsonify(ok=True, status="ok", ept=ept,
                       squares=round(r["sq"] * CAL, 1),
                       raw_squares=round(r["sq"], 1),
                       footprint_sqft=round(r["fp"], 1),
                       npts=r["npts"], seethrough=round(r["stratio"], 2), blob=r["blob"])
    finally:
        for p in (out, out + ".json"):
            try:
                os.remove(p)
            except Exception:
                pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
