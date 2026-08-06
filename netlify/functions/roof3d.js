// netlify/functions/roof3d.js
//
// 3D TAKEOFF — the whole team on one screen, traced FACET BY FACET.
//   • Google Photorealistic 3D Tiles flown to an oblique view over the house.
//   • You trace ONE roof plane at a time (its corners) → "Add facet" banks that
//     plane's TRUE 3D area (pitch baked in, from real 3D coords) → start the next.
//     Multi-level / multi-pitch roofs just work — each level is its own facet, and
//     there's no tangled single-polygon mess.
//   • Google Solar's squares+pitch fetched for the same roof, with a live agreement
//     readout (green ≤5%, amber ≤12%, red else) — the council checking your hand.
//
//   GET /.netlify/functions/roof3d[?lat=..&lng=..&addr=..]  (default 4333 Cheval)
//
// Key injected server-side (already client-exposed, restricted to our Maps APIs).

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
  #hud{top:10px;left:10px;max-width:290px}
  #hud b{color:#7dd3fc}
  #score{bottom:14px;left:10px;min-width:250px}
  #score .big{font-size:26px;font-weight:800;color:#fff;line-height:1.1}
  #score .row{display:flex;justify-content:space-between;gap:14px;margin-top:3px}
  #score .team{color:#a5b4fc}
  #agree{font-weight:800;padding:2px 8px;border-radius:999px;font-size:12px}
  .btns{position:absolute;top:10px;right:10px;z-index:6;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:360px}
  .btn{background:#1e293b;color:#fff;border:1px solid #334155;border-radius:8px;padding:9px 13px;font-size:13px;font-weight:700;cursor:pointer}
  .btn.go{background:#16a34a;border-color:#16a34a}
  .btn.red{background:#7f1d1d;border-color:#991b1b}
  #err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fca5a5;font-size:15px;text-align:center;z-index:9;display:none;max-width:80%}
  .cesium-viewer-bottom{display:none}
</style></head>
<body>
<div id="c"></div>
<div id="hud" class="panel"><b>${addr}</b><br>
  Trace <b>one roof plane at a time</b>: click its corners, then <b>✓ Add facet</b>. Do each slope/level separately — they add up.<br>
  <span style="color:#94a3b8">Drag to orbit the roof — even mid-trace — scroll to zoom. Turn to reach the far corners.</span>
</div>
<div class="btns">
  <button class="btn go" onclick="addFacet()">✓ Add facet</button>
  <button class="btn" onclick="undo()">↩ Undo</button>
  <button class="btn red" onclick="clearAll()">✕ Clear</button>
</div>
<div id="score" class="panel">
  <div>Roof so far</div>
  <div class="big"><span id="tracesq">0.0</span> sq</div>
  <div id="meta" style="font-size:12px;color:#94a3b8"></div>
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
    var tileset = await Cesium.Cesium3DTileset.fromUrl("https://tile.googleapis.com/v1/3dtiles/root.json?key=${KEY}", {showCreditsOnScreen:false});
    viewer.scene.primitives.add(tileset);
    // Orbit AROUND the house so you can turn the view mid-trace to reach corners on
    // the far side — lookAt makes drag circle the roof instead of spinning in place.
    var CENTER = Cesium.Cartesian3.fromDegrees(LNG, LAT, 12);
    viewer.camera.lookAt(CENTER, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-38), 95));

    var facets=[];      // {pts:[Cartesian3], areaM2}
    var facetEnt=[];    // committed facet polygon entities
    var cur=[];         // current facet points
    var curMk=[];       // current facet markers

    // current-facet outline (yellow) — the one you're drawing now
    viewer.entities.add({ polyline:{ width:3, material:Cesium.Color.YELLOW,
      positions:new Cesium.CallbackProperty(function(){ return cur.length>1 ? cur.concat(cur.length>2?[cur[0]]:[]) : cur; },false) } });

    function area3D(P){ if(P.length<3) return 0; var a=P[0],s=0,t=new Cesium.Cartesian3();
      for(var i=1;i<P.length-1;i++){ var ab=Cesium.Cartesian3.subtract(P[i],a,new Cesium.Cartesian3());
        var ac=Cesium.Cartesian3.subtract(P[i+1],a,new Cesium.Cartesian3());
        Cesium.Cartesian3.cross(ab,ac,t); s+=0.5*Cesium.Cartesian3.magnitude(t); } return s; }
    function committed(){ var s=0; facets.forEach(function(f){s+=f.areaM2;}); return s; }

    function refresh(){
      var totM2 = committed() + area3D(cur);
      var sq = totM2/9.290304;
      document.getElementById("tracesq").textContent = sq.toFixed(1);
      var m = facets.length + " facet" + (facets.length===1?"":"s");
      if(cur.length) m += " · drawing (" + cur.length + " pts, +" + (area3D(cur)/9.290304).toFixed(1) + " sq)";
      document.getElementById("meta").textContent = m;
      window.__cmp(sq);
    }
    window.addFacet=function(){
      if(cur.length<3){ return; }
      var P=cur.slice();
      facets.push({pts:P, areaM2:area3D(P)});
      facetEnt.push(viewer.entities.add({ polygon:{ hierarchy:new Cesium.PolygonHierarchy(P),
        material:Cesium.Color.LIME.withAlpha(0.4), perPositionHeight:true, outline:true, outlineColor:Cesium.Color.LIME } }));
      cur.length=0; curMk.forEach(function(x){viewer.entities.remove(x);}); curMk.length=0;
      refresh();
    };
    window.undo=function(){
      if(cur.length){ cur.pop(); var m=curMk.pop(); if(m)viewer.entities.remove(m); }
      else if(facets.length){ facets.pop(); var e=facetEnt.pop(); if(e)viewer.entities.remove(e); }
      refresh();
    };
    window.clearAll=function(){
      facets.length=0; facetEnt.forEach(function(e){viewer.entities.remove(e);}); facetEnt.length=0;
      cur.length=0; curMk.forEach(function(x){viewer.entities.remove(x);}); curMk.length=0;
      refresh();
    };
    function addPt(pos){ cur.push(pos);
      curMk.push(viewer.entities.add({ position:pos, point:{ pixelSize:11, color:Cesium.Color.YELLOW, outlineColor:Cesium.Color.WHITE, outlineWidth:2, disableDepthTestDistance:Number.POSITIVE_INFINITY } }));
      refresh(); }

    var h=new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction(function(click){ var pos=viewer.scene.pickPosition(click.position); if(Cesium.defined(pos)) addPt(pos); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // double-click a facet's last point to close it fast
    h.setInputAction(function(){ window.addFacet(); }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    var solarSq=null;
    window.__cmp=function(sq){ var el=document.getElementById("agree");
      if(solarSq==null||!sq){ el.textContent="—"; el.style.background="#334155"; return; }
      var d=Math.round(Math.abs(sq-solarSq)/solarSq*100);
      el.textContent="±"+d+"%"; el.style.background = d<=5?"#16a34a" : d<=12?"#b45309" : "#b91c1c"; };
    fetch("/.netlify/functions/harvest-roof-report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat:LAT,lng:LNG})})
      .then(function(r){return r.json();}).then(function(d){
        if(d&&d.ok&&d.roof&&d.roof.surface_squares){ solarSq=d.roof.surface_squares;
          document.getElementById("solarsq").textContent=solarSq.toFixed(1)+" sq · "+(d.roof.avg_pitch_x12||"?")+"/12"; window.__cmp(parseFloat(document.getElementById("tracesq").textContent)); }
        else document.getElementById("solarsq").textContent="n/a";
      }).catch(function(){ document.getElementById("solarsq").textContent="n/a"; });
  }catch(e){ document.getElementById("err").style.display="block"; document.getElementById("err").textContent="3D tiles failed: "+(e&&e.message||e); }
})();
</script>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: html };
};
