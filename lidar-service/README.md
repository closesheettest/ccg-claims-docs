# LiDAR roof cross-check — the third teammate

This is the LiDAR vote for the roof-measure **Team Read** (Solar + County records + **LiDAR**).
It's a small container that reads free USGS 3DEP LiDAR and returns a roof-squares estimate.
The live tool already blends Solar + Records; this adds the third, most independent voter.

**You deploy it once. Nothing here charges you** — your volume stays inside Cloud Run's
free tier ($0/mo, scale-to-zero). "Billing on" is just a *requirement* to use Cloud Run,
not a charge (like putting a card on file at a place with a free plan).

---

## One-time setup (Google Cloud Console, ~5 min)

Do this in the SAME Google project as your Maps key (`silicon-garage-490316-a1`).

1. **Turn on billing** — https://console.cloud.google.com/billing → link a billing account
   to the project. (Free tier still needs this attached. You won't be charged at your volume.)
2. **Enable 3 APIs** (each is one blue "Enable" button):
   - Cloud Run API — https://console.cloud.google.com/apis/library/run.googleapis.com
   - Cloud Build API — https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com
   - Artifact Registry API — https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com

## Deploy (one command)

Install the Google Cloud SDK once (https://cloud.google.com/sdk/docs/install), then:

```bash
gcloud auth login
gcloud config set project silicon-garage-490316-a1
cd lidar-service
gcloud run deploy lidar-roof \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 \
  --timeout 300 --concurrency 4
```

Cloud Build builds the container in the cloud (no Docker needed on your Mac) and Cloud Run
deploys it. When it finishes it prints a **Service URL** like
`https://lidar-roof-xxxxx-ue.a.run.app`.

## Wire it into the tool (one env var)

In **Netlify** (free-roof-inspections site) → Site settings → Environment variables, add:

```
LIDAR_SERVICE_URL = https://lidar-roof-xxxxx-ue.a.run.app
```

Redeploy the site (or it picks it up next deploy). That's it — the Team Read will start
showing a **LiDAR** vote automatically, and the median becomes a true 3-way council.

## Test it directly (optional)

```bash
curl -s -X POST https://lidar-roof-xxxxx-ue.a.run.app/measure \
  -H 'Content-Type: application/json' \
  -d '{"lat":27.1195802,"lng":-82.4455905,"pitch":1}'
# 401 Colonia Ln E — Roofr says 68.27 sq
```

## How it works

`POST /measure {lat,lng,pitch}` → pulls a 64 m box of 3DEP LiDAR via PDAL, separates roof
from ground/cage/tree by **ground occlusion** (a solid roof blocks the laser from the
ground; a screen cage lets it through) and **planarity** (roof is smooth, canopy is rough),
isolates the roof nearest the pin, triangulates a footprint, applies the slope factor, and
returns squares (calibrated ×1.05 vs Roofr). Same pipeline validated on 183 Roofr roofs.
