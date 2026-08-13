/* add-to-dashboard.js — the universal "➕ Add to my dashboard" widget.
 *
 * Embed on ANY U.S. Shingle app with one line:
 *   <script src="https://free-roof-inspections.netlify.app/add-to-dashboard.js" defer></script>
 *
 * It (1) names the browser tab after the current tool, and (2) shows a floating
 * "Add to my dashboard" button so an office/admin person can add the page they're on
 * to their My Tools launcher (?mode=mytools on the main app). Identity (name + PIN)
 * is entered once per app/device and stored in that app's localStorage; every save
 * goes to the main app's manager-dashboard function over CORS, so one person's
 * dashboard is the same list no matter which app they added a tool from.
 *
 * The CCG main app has its own in-app React version of this button — do NOT also load
 * this script there. Load it on TMS and the other standalone apps.
 *
 * Keep the TOOL map below in sync with the CATALOG in src/MyToolsPage.jsx.
 */
(function () {
  "use strict";
  if (window.__uss_add_dashboard) return; // guard against double-embed
  window.__uss_add_dashboard = true;

  var MAIN = "https://free-roof-inspections.netlify.app";
  var API = MAIN + "/.netlify/functions/manager-dashboard";
  var USERS_API = MAIN + "/.netlify/functions/jobnimbus-users";
  var LS_NAME = "ccg_mytools_name", LS_PIN = "ccg_mytools_pin";

  // Map the current page → [catalogKey, tabLabel]. Kept in sync with MyToolsPage CATALOG.
  var TMS = {
    "/": ["tms_home", "Training Dashboard"],
    "/calendar": ["tms_calendar", "Training Calendar"],
    "/progress": ["tms_progress", "Progress Funnel"],
    "/attendance": ["tms_attendance", "Attendance"],
    "/homework": ["tms_homework", "Homework Status"],
    "/provisioning": ["tms_provisioning", "Provisioning"],
    "/manager": ["tms_manager", "Hiring Manager"],
    "/active-reps": ["tms_active_reps", "Active Sales Reps"],
    "/regional-managers": ["tms_regional_mgrs", "Regional Managers"],
    "/rep-map": ["tms_repmap", "Sales Team Map"],
    "/regions": ["tms_regions", "Zones"],
    "/group-messages": ["tms_group_messages", "Group Messages"],
    "/manage-directory": ["tms_directory_admin", "Manage Directory"],
    "/directory": ["tms_directory", "Team Directory"],
    "/messages": ["tms_messages", "Messages"],
    "/notifications": ["tms_notifications", "Notifications"],
    "/message-templates": ["tms_templates", "Message Templates"],
    "/handoff-contacts": ["tms_handoff", "Handoff Contacts"],
    "/personas": ["tms_personas", "Personas"],
    "/hosted-pages": ["tms_hosted", "Hosted Pages"],
    "/locations": ["tms_locations", "Locations"],
    "/hotels": ["tms_hotels", "Hotels"],
    "/welcome-links": ["tms_welcome_links", "Welcome Page Links"],
    "/questions": ["tms_questions", "Test Questions"],
    "/testimonials": ["tms_testimonials", "Testimonials"],
    "/training-week": ["tms_training_week", "Training Week"],
    "/ongoing-training": ["tms_ongoing", "Ongoing Training"],
    "/field-trainee": ["tms_field_trainee", "Field Trainee"],
    "/system-overview.html": ["tms_overview", "TMS System Overview"]
  };

  function currentTool() {
    var h = location.hostname;
    if (h.indexOf("trainingmanagementsys") >= 0) {
      var p = location.pathname.replace(/\/+$/, "") || "/";
      // token/public pages (register/confirm/test/kiosk/regional-manager/etc.) aren't tools
      if (/^\/(register|confirm|credentials|test|kiosk|welcome|results|update-info|quiz|apps|review-training-day|regional-manager|class)\b/.test(p)) return null;
      return TMS[p] || null;
    }
    if (h.indexOf("us-shingle-rep-dashboard") >= 0) return ["rep_dashboard", "Rep Dashboard"];
    if (h.indexOf("usshinglesalessheet") >= 0) return ["closesheet", "Close Sheet"];
    if (h.indexOf("us-shingle-forms") >= 0) return ["forms", "U.S. Shingle Forms"];
    if (h.indexOf("golden-banoffee") >= 0) return ["install_finder", "Install Finder"];
    return null;
  }

  function getIdent() {
    try { var n = localStorage.getItem(LS_NAME) || "", pin = localStorage.getItem(LS_PIN) || ""; return (n && pin) ? { name: n, pin: pin } : null; } catch (e) { return null; }
  }
  function setIdent(name, pin) { try { localStorage.setItem(LS_NAME, name); localStorage.setItem(LS_PIN, pin); } catch (e) {} }

  // ---- styling (scoped, inline) ----
  var NAVY = "#0f2a4a";
  function css(el, o) { for (var k in o) el.style[k] = o[k]; }

  var root, btn, tool, tools = null, ident = getIdent();

  function render() {
    if (!tool) return;
    if (!btn) {
      root = document.createElement("div");
      css(root, { position: "fixed", left: "12px", bottom: "12px", zIndex: "2147483000", fontFamily: '-apple-system,"Segoe UI",Helvetica,Arial,sans-serif' });
      btn = document.createElement("button");
      css(btn, { display: "flex", alignItems: "center", gap: "7px", border: "none", borderRadius: "999px", padding: "10px 15px", fontSize: "13.5px", fontWeight: "800", cursor: "pointer", color: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,.28)" });
      btn.onclick = onClick;
      root.appendChild(btn);
      (document.body || document.documentElement).appendChild(root);
    }
    var added = tools && tools.indexOf(tool[0]) >= 0;
    btn.textContent = added ? "✓ On your dashboard" : "➕ Add to my dashboard";
    btn.disabled = !!added;
    css(btn, { background: added ? "#16a34a" : NAVY, cursor: added ? "default" : "pointer", opacity: "1" });
    btn.title = added ? "This tool is on your My Tools dashboard" : ("Add " + tool[1] + " to your My Tools dashboard");
  }

  function loadTools() {
    if (!ident) { render(); return; }
    fetch(API + "?manager=" + encodeURIComponent(ident.name))
      .then(function (r) { return r.json(); })
      .then(function (d) { tools = Array.isArray(d.tools) ? d.tools : []; render(); })
      .catch(function () { tools = []; render(); });
  }

  function onClick() {
    if (!ident) { promptSignIn(); return; }
    if (!tool || (tools && tools.indexOf(tool[0]) >= 0)) return;
    btn.textContent = "Adding…"; btn.disabled = true; css(btn, { opacity: "0.6" });
    var next = (tools || []).slice();
    if (next.indexOf(tool[0]) < 0) next.push(tool[0]);
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", pin: ident.pin, manager: ident.name, tools: next }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { tools = next; } render(); })
      .catch(function () { render(); });
  }

  // ---- first-time sign-in popover (name autocomplete + PIN) ----
  function promptSignIn() {
    if (document.getElementById("uss-atd-pop")) return;
    var pop = document.createElement("div");
    pop.id = "uss-atd-pop";
    css(pop, { position: "fixed", left: "12px", bottom: "58px", zIndex: "2147483001", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "14px", boxShadow: "0 10px 34px rgba(0,0,0,.28)", padding: "14px", width: "270px", fontFamily: '-apple-system,"Segoe UI",Helvetica,Arial,sans-serif' });
    pop.innerHTML =
      '<div style="font-weight:800;color:' + NAVY + ';font-size:14.5px;margin-bottom:2px">Add to your dashboard</div>' +
      '<div style="font-size:12px;color:#64748b;margin-bottom:9px">Use the same name + passcode as your My Tools launcher.</div>' +
      '<input id="uss-atd-name" list="uss-atd-users" placeholder="Your name" autocomplete="off" style="width:100%;box-sizing:border-box;font-size:14px;padding:9px 10px;border:1px solid #cbd5e1;border-radius:9px;margin-bottom:7px" />' +
      '<datalist id="uss-atd-users"></datalist>' +
      '<input id="uss-atd-pin" type="password" inputmode="numeric" placeholder="Passcode" style="width:100%;box-sizing:border-box;font-size:14px;padding:9px 10px;border:1px solid #cbd5e1;border-radius:9px;margin-bottom:9px" />' +
      '<div id="uss-atd-err" style="color:#dc2626;font-size:12px;margin-bottom:7px;display:none"></div>' +
      '<div style="display:flex;gap:8px"><button id="uss-atd-cancel" style="flex:0 0 auto;font-size:13px;font-weight:700;padding:9px 12px;border-radius:9px;border:1px solid #e2e8f0;background:#fff;color:#64748b;cursor:pointer">Cancel</button>' +
      '<button id="uss-atd-go" style="flex:1;font-size:14px;font-weight:800;padding:9px 12px;border-radius:9px;border:none;background:' + NAVY + ';color:#fff;cursor:pointer">Save name & add</button></div>';
    (document.body || document.documentElement).appendChild(pop);
    document.getElementById("uss-atd-cancel").onclick = function () { pop.remove(); };
    // populate the name autocomplete from JN users
    fetch(USERS_API).then(function (r) { return r.json(); }).then(function (d) {
      var dl = document.getElementById("uss-atd-users"); if (!dl || !d || !d.members) return;
      d.members.forEach(function (u) { var o = document.createElement("option"); o.value = u.name; dl.appendChild(o); });
    }).catch(function () {});
    document.getElementById("uss-atd-go").onclick = function () {
      var name = (document.getElementById("uss-atd-name").value || "").trim();
      var pin = (document.getElementById("uss-atd-pin").value || "").trim();
      var err = document.getElementById("uss-atd-err");
      if (!name || pin.length < 4) { err.textContent = "Enter your name and a 4–8 digit PIN."; err.style.display = "block"; return; }
      this.textContent = "Checking…"; this.disabled = true;
      fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "auth", manager: name, pin: pin }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d.ok) { err.textContent = res.d && res.d.error ? res.d.error : "Incorrect PIN."; err.style.display = "block"; document.getElementById("uss-atd-go").textContent = "Save name & add"; document.getElementById("uss-atd-go").disabled = false; return; }
          setIdent(name, pin); ident = { name: name, pin: pin }; pop.remove();
          loadTools(); setTimeout(onClick, 400); // add the current tool now that we're signed in
        })
        .catch(function () { err.textContent = "Couldn't reach the server."; err.style.display = "block"; document.getElementById("uss-atd-go").textContent = "Save name & add"; document.getElementById("uss-atd-go").disabled = false; });
    };
  }

  // ---- boot + SPA route awareness ----
  function evaluate() {
    var t = currentTool();
    if (t) { try { document.title = t[1] + " · U.S. Shingle"; } catch (e) {} }
    // rep-token pages are field-facing — never bug a rep with an admin button
    if (t && location.search.indexOf("rt=") >= 0) t = null;
    var changed = !tool || !t || tool[0] !== t[0];
    tool = t;
    if (!tool) { if (root) root.style.display = "none"; return; }
    if (root) root.style.display = "";
    if (changed) loadTools(); else render();
  }
  function boot() { evaluate(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  // React-Router (TMS) changes the URL without a reload — re-evaluate on nav.
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m]; history[m] = function () { var r = orig.apply(this, arguments); setTimeout(evaluate, 60); return r; };
  });
  window.addEventListener("popstate", function () { setTimeout(evaluate, 60); });
})();
