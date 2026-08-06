// netlify/functions/roof3d.js
//
// Live Photorealistic 3D viewer of a roof — Google's 3D Tiles (the Earth mesh)
// rendered in CesiumJS, flown to an oblique view over the house so you can spin
// around it and see roof-vs-cage-vs-tree from any angle. This is the surface the
// TAKEOFF tool will draw exact ridge/hip/valley lines on.
//
//   GET /.netlify/functions/roof3d[?lat=..&lng=..&addr=..]
//   default: 4333 Cheval Blvd, Lutz (the pool-cage benchmark)
//
// The Maps key is injected server-side. It's already client-exposed elsewhere in
// the app and restricted to our 6 Maps APIs — fine for this viewer; a production
// takeoff tool would proxy the tiles to keep the key fully server-side.

const KEY = process.env.VITE_GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

export const handler = async (event) => {
  const p = (event && event.queryStringParameters) || {};
  const lat = parseFloat(p.lat) || 28.1523983;
  const lng = parseFloat(p.lng) || -82.5081649;
  const addr = (p.addr || "4333 Cheval Blvd, Lutz FL").replace(/[<>"]/g, "");
  if (!KEY) return { statusCode: 500, body: "Maps key not set" };

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>3D Roof — ${addr}</title>
<script src="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Cesium.js"></script>
<link href="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
<style>
  html,body,#c{margin:0;height:100%;width:100%;overflow:hidden;background:#0b0f14;font-family:system-ui,sans-serif}
  #hud{position:absolute;top:10px;left:10px;z-index:5;background:rgba(15,23,42,.82);color:#fff;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;max-width:320px}
  #hud b{color:#7dd3fc}
  #err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fca5a5;font-size:15px;text-align:center;z-index:6;display:none;max-width:80%}
  .cesium-viewer-bottom{display:none}
</style></head>
<body>
<div id="c"></div>
<div id="hud"><b>${addr}</b><br>Drag to orbit · scroll to zoom · right-drag to tilt.<br><span style="color:#94a3b8">Google Photorealistic 3D · the takeoff draws on this.</span></div>
<div id="err"></div>
<script>
(async function(){
  try{
    Cesium.Ion.defaultAccessToken = undefined;   // no Cesium Ion — we only use Google tiles
    const viewer = new Cesium.Viewer("c", {
      globe:false, baseLayerPicker:false, geocoder:false, homeButton:false,
      sceneModePicker:false, navigationHelpButton:false, animation:false, timeline:false,
      infoBox:false, selectionIndicator:false, fullscreenButton:true, creditContainer:document.createElement("div")
    });
    viewer.scene.skyAtmosphere.show = false;
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      "https://tile.googleapis.com/v1/3dtiles/root.json?key=${KEY}", { showCreditsOnScreen:false }
    );
    viewer.scene.primitives.add(tileset);
    // oblique view: sit ~140m south of the house, ~95m up, looking north-down.
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(${lng}, ${lat - 0.00125}, 95),
      orientation:{ heading:Cesium.Math.toRadians(0), pitch:Cesium.Math.toRadians(-38), roll:0 },
      duration:0
    });
  }catch(e){
    document.getElementById("err").style.display="block";
    document.getElementById("err").textContent = "3D tiles failed to load: " + (e && e.message || e);
  }
})();
</script>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html };
};
