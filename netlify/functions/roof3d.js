// netlify/functions/roof3d.js
//
// 3D TAKEOFF — the whole team on one screen.
//   • Google Photorealistic 3D Tiles (the Earth mesh) flown to an oblique view.
//   • You CLICK the roof edges on the real 3D surface → it traces a polygon and
//     computes TRUE 3D area (pitch is baked in — the points are real 3D coords,
//     not a flat projection).
//   • The team's read (Google Solar squares + pitch) is fetched and shown right
//     beside your trace, with a live agreement readout — green when you agree,
//     flagged when you drift.
//
//   GET /.netlify/functions/roof3d[?lat=..&lng=..&addr=..]  (default 4333 Cheval)
//
// Key injected server-side (already client-exposed elsewhere, restricted to our
// Maps APIs). A production tool would proxy the tiles to hide it fully.

const KEY = process.env.VITE_GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

export const handler = async (event) => {
  const p = (event && event.queryStringParameters) || {};
  const lat = parseFloat(p.lat) || 28.1523983;
  const lng = parseFloat(p.lng) || -82.5081649;
  const addr = (p.addr || "4333 Cheval Blvd, Lutz FL").replace(/[<>"]/g, "");
  if (!KEY) return { statusCode: 500, body: "Maps key not set" };

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>3D Takeoff — ${addr}</title>
<script src="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Cesium.js"></script>
<link href="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
<style>
  html,body,#c{margin:0;height:100%;width:100%;overflow:hidden;background:#0b0f14;font-family:system-ui,sans-serif}
  .panel{position:absolute;z-index:5;background:rgba(15,23,42,.9);color:#e5edf5;border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.5}
  #hud{top:10px;left:10px;max-width:300px}
  #hud b{color:#7dd3fc}
  #score{bottom:14px;left:10px;min-width:240px}
  #score .big{font-size:26px;font-weight:800;color:#fff;line-height:1.1}
  #score .row{display:flex;justify-content:space-between;gap:14px;margin-top:3px}
  #score .team{color:#a5b4fc}
  #agree{font-weight:800;padding:2px 8px;border-radius:999px;font-size:12px}
  .btns{position:absolute;top:10px;right:10px;z-index:6;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:340px}
  .btn{background:#1e293b;color:#fff;border:1px solid #334155;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer}
  .btn.go{background:#16a34a;border-color:#16a34a}
  .btn.red{background:#7f1d1d;border-color:#991b1b}
  #err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fca5a5;font-size:15px;text-align:center;z-index:9;display:none;max-width:80%}
  .cesium-viewer-bottom{display:none}
</style></head>
<body>
<div id="c"></div>
<div id="hud" class="panel"><b>${addr}</b><br>
  Click the roof's corners along its edges to trace it — the points snap to the real 3D surface, so the area comes out with the pitch already in it.<br>
  <span style="color:#94a3b8">Drag empty space to orbit · scroll to zoom.</span>
</div>
<div class="btns">
  <button class="btn" onclick="undoPt()">↩ Undo</button>
  <button class="btn go" onclick="finishTrace()">✓ Close</button>
  <button class="btn red" onclick="clearTrace()">✕ Clear</button>
</div>
<div id="score" class="panel">
  <div>Your 3D trace</div>
  <div class="big"><span id="tracesq">0.0</span> sq <span id="npts" style="font-size:13px;color:#94a3b8;font-weight:400"></span></div>
  <div class="row"><span class="team">🛰️ Team (Solar)</span><span id="solarsq" class="team">loading…</span></div>
  <div class="row"><span>Agreement</span><span id="agree" style="background:#334155">—</span></div>
</div>
<div id="err"></div>
<script>
(async function(){
  var LAT=${lat}, LNG=${lng};
  try{
    Cesium.Ion.defaultAccessToken = undefined;
    var viewer = new Cesium.Viewer("c", {
      globe:false, baseLayerPicker:false, geocoder:false, homeButton:false,
      sceneModePicker:false, navigationHelpButton:false, animation:false, timeline:false,
      infoBox:false, selectionIndicator:false, fullscreenButton:true, creditContainer:document.createElement("div")
    });
    viewer.scene.skyAtmosphere.show=false;
    window.__v=viewer;
    var tileset = await Cesium.Cesium3DTileset.fromUrl("https://tile.googleapis.com/v1/3dtiles/root.json?key=${KEY}", {showCreditsOnScreen:false});
    viewer.scene.primitives.add(tileset);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(LNG, LAT-0.00125, 95),
      orientation:{ heading:0, pitch:Cesium.Math.toRadians(-38), roll:0 }, duration:0
    });

    // ── trace state
    var pts=[];                       // Cartesian3 on the mesh
    var markers=[];
    window.__poly = viewer.entities.add({
      polygon:{ hierarchy:new Cesium.CallbackProperty(function(){ return new Cesium.PolygonHierarchy(pts); },false),
                material:Cesium.Color.LIME.withAlpha(0.35), perPositionHeight:true, outline:false },
      polyline:{ positions:new Cesium.CallbackProperty(function(){ return pts.length>1?pts.concat(pts.length>2?[pts[0]]:[]):pts; },false),
                 width:3, material:Cesium.Color.LIME, clampToGround:false }
    });

    function area3D(P){ if(P.length<3) return 0; var a=P[0],s=0,t=new Cesium.Cartesian3();
      for(var i=1;i<P.length-1;i++){ var ab=Cesium.Cartesian3.subtract(P[i],a,new Cesium.Cartesian3());
        var ac=Cesium.Cartesian3.subtract(P[i+1],a,new Cesium.Cartesian3());
        Cesium.Cartesian3.cross(ab,ac,t); s+=0.5*Cesium.Cartesian3.magnitude(t); } return s; }
    function refresh(){
      var sq = area3D(pts)/9.290304;
      document.getElementById("tracesq").textContent = sq.toFixed(1);
      document.getElementById("npts").textContent = pts.length?("· "+pts.length+" pts"):"";
      window.__cmp(sq);
    }
    window.__addPt=function(pos){ pts.push(pos);
      markers.push(viewer.entities.add({ position:pos, point:{ pixelSize:11, color:Cesium.Color.LIME, outlineColor:Cesium.Color.WHITE, outlineWidth:2, disableDepthTestDistance:Number.POSITIVE_INFINITY } }));
      refresh(); };
    window.undoPt=function(){ if(!pts.length)return; pts.pop(); var m=markers.pop(); if(m)viewer.entities.remove(m); refresh(); };
    window.clearTrace=function(){ pts.length=0; markers.forEach(function(m){viewer.entities.remove(m);}); markers.length=0; refresh(); };
    window.finishTrace=function(){ refresh(); };

    // click the mesh → exact 3D point
    var h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction(function(click){
      var pos = viewer.scene.pickPosition(click.position);
      if(Cesium.defined(pos)) window.__addPt(pos);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // ── the team's read (Google Solar) for the same roof
    var solarSq=null;
    window.__cmp=function(sq){
      var el=document.getElementById("agree");
      if(solarSq==null||!sq){ el.textContent="—"; el.style.background="#334155"; return; }
      var d=Math.round(Math.abs(sq-solarSq)/solarSq*100);
      el.textContent="±"+d+"%";
      el.style.background = d<=5?"#16a34a" : d<=12?"#b45309" : "#b91c1c";
    };
    fetch("/.netlify/functions/harvest-roof-report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat:LAT,lng:LNG})})
      .then(function(r){return r.json();}).then(function(d){
        if(d&&d.ok&&d.roof&&d.roof.surface_squares){ solarSq=d.roof.surface_squares;
          document.getElementById("solarsq").textContent = solarSq.toFixed(1)+" sq · "+ (d.roof.avg_pitch_x12||"?")+"/12";
        } else document.getElementById("solarsq").textContent="n/a";
      }).catch(function(){ document.getElementById("solarsq").textContent="n/a"; });
  }catch(e){
    document.getElementById("err").style.display="block";
    document.getElementById("err").textContent="3D tiles failed: "+(e&&e.message||e);
  }
})();
</script>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html };
};
