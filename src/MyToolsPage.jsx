// src/MyToolsPage.jsx
//
// "My Tools" — a per-manager launcher at /?mode=mytools.
//
// Flow:  pick your name  →  manager PIN (the FIRST person to enter it sets it
// for the team)  →  your own dashboard of just the tools you use.  A ⚙️ Customize
// button is always on the dashboard, so a manager can add or remove tools anytime.
//
// Storage lives server-side (netlify/functions/manager-dashboard.js) keyed by name,
// so a manager's picks follow them to any phone. The name + PIN are remembered on
// the device for convenience (same idea as the Manager Console), but every tool
// selection is saved to the server.

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

const API = "/.netlify/functions/manager-dashboard";

// Office/admin people identify themselves by typing their name — matches are pulled
// live from the JobNimbus user list (jobnimbus-users), so anyone with a JN account can
// build their own dashboard and new hires need no setup. (Zone managers use their own
// tokenized /regional-manager dashboards — this is NOT for them.)
const JN_USERS_API = "/.netlify/functions/jobnimbus-users";

// The full tool catalog managers pick from. `href` = same-tab-safe route in this
// app (opened in a new tab); `token: true` = office map that needs the admin token
// (fetched once behind the PIN); `external: true` = a separate site.
// Roof Measurement / Takeoff are intentionally omitted (not unveiled yet).
const CATALOG = [
  // ── Door-Knocking (DoorDispatcher) ──
  { key: "harvest_map", cat: "Door-Knocking", emoji: "🗺️", label: "DoorDispatcher (office map)", desc: "The whole door-knock map — every pin, all teams.", token: "harvest" },
  { key: "harvest_report", cat: "Door-Knocking", emoji: "📊", label: "Rep Activity", desc: "Each rep's canvassing: pins visited, rounds, outcomes, last active.", href: "/?mode=harvestreport" },
  { key: "harvest_plannedday", cat: "Door-Knocking", emoji: "🧭", label: "Planned Day", desc: "Each senior rep's assigned section (IQ + No-sit clusters) for the day.", href: "/?mode=harvestplannedday" },
  { key: "harvest_nosit", cat: "Door-Knocking", emoji: "🔁", label: "No-Sits to Re-book", desc: "Company-wide No-Sit backlog by team, with a progress benchmark.", href: "/?mode=harvestnositreport" },
  { key: "harvest_links", cat: "Door-Knocking", emoji: "🔗", label: "Rep Links & Access", desc: "Each rep's personal map link + level, to hand out.", href: "/?mode=harvestlinks" },
  { key: "harvest_upload", cat: "Door-Knocking", emoji: "📥", label: "Load Leads", desc: "Upload a CSV of leads, mark its pin type, delete a bad upload.", href: "/?mode=harvestupload" },
  { key: "harvest_types", cat: "Door-Knocking", emoji: "🎛️", label: "Pin Types", desc: "Create & edit pin types: color, who sees them, allowed outcomes.", href: "/?mode=harvestadmin" },
  { key: "appt_schedule", cat: "Door-Knocking", emoji: "📅", label: "Appointment Scheduler", desc: "Set the standard appointment times + last time per day.", href: "/?mode=scheduleadmin" },
  { key: "harvest_jnsync", cat: "Door-Knocking", emoji: "🔄", label: "JN Sync", desc: "Which JobNimbus statuses/sources flow onto the map + manual sync.", href: "/?mode=harvestjnsync" },
  { key: "harvest_skiptrace", cat: "Door-Knocking", emoji: "📇", label: "Skip-Trace", desc: "Look up owner name + phone for an address before you knock.", href: "/?mode=harvestskiptrace" },
  { key: "harvest_training", cat: "Door-Knocking", emoji: "🎓", label: "Tool Training", desc: "The video + 80% test that unlock DoorDispatcher for reps.", href: "/?mode=harvesttrainingadmin" },
  { key: "harvest_howto", cat: "Door-Knocking", emoji: "📖", label: "How-To Library", desc: "Build the rep tool reference reps open from the ❓ on their map.", href: "/?mode=harvesthowtoadmin" },

  // ── Inspections ──
  { key: "inspection_map", cat: "Inspections", emoji: "🔍", label: "Inspection Map (office)", desc: "Every roof still needing an inspection — route-my-day + route-lock.", token: "inspect" },
  { key: "inspector_links", cat: "Inspections", emoji: "🔗", label: "Inspector Links", desc: "Each active inspector's personal map link, to hand out.", href: "/?mode=inspectorlinks" },
  { key: "inspect_report", cat: "Inspections", emoji: "📊", label: "Inspector Activity (live)", desc: "Pin-by-pin times + GPS: roofs per day, arrival/finish, real miles.", href: "/?mode=inspectvisitreport" },
  { key: "master_inspection_report", cat: "Inspections", emoji: "📑", label: "Master Inspection Reports", desc: "The whole free-roof-inspection pipeline on one page.", href: "/?mode=masterinspreport" },
  { key: "goback_schedule", cat: "Inspections", emoji: "🗓️", label: "After-Inspection Self-Scheduling", desc: "The come-back-review text sequence — on/off, timing, message bodies.", href: "/?mode=gobackschedule" },

  // ── Public Adjuster ──
  { key: "pa_resched_compose", cat: "Public Adjuster", emoji: "✉️", label: "Reschedule Text Composer", desc: "The bulk text to homeowners whose PA appointment passed unsigned.", href: "/?mode=pareschedcompose" },
  { key: "pa_portal", cat: "Public Adjuster", emoji: "🧑‍⚖️", label: "PA Portal (admin)", desc: "The PA portal with admin powers — assign, release, enter milestones.", href: "/?mode=pa&admin=1" },

  // ── Installs ──
  { key: "installs_map", cat: "Installs", emoji: "🗺️", label: "Installs Map", desc: "Live map of current installs, colored by jobsite foreman.", href: "/?mode=installs" },
  { key: "foreman_links", cat: "Installs", emoji: "🔗", label: "Foreman Links", desc: "Each foreman's personal link, to hand out.", href: "/?mode=foremanlinks" },

  // ── Sales & Settings ──
  { key: "contest", cat: "Sales & Settings", emoji: "🏁", label: "Contest Leaderboard", desc: "Turn the Positive-Effort Contest board on/off + preview standings.", href: "/?mode=contest" },
  { key: "manager_console", cat: "Sales & Settings", emoji: "🛠️", label: "Manager Console (full toolbox)", desc: "Every admin tool in one place — reports, templates, rosters, settings.", href: "/?mode=manager" },
  { key: "setter", cat: "Sales & Settings", emoji: "📞", label: "Setter Portal", desc: "Book a retail appointment for an inbound call — picks a qualified rep.", href: "/?mode=setter" },
  { key: "crews", cat: "Sales & Settings", emoji: "👷", label: "Crew Onboarding", desc: "Onboard a subcontractor crew — set rates, send the packet, track it.", href: "/?mode=crews" },
  { key: "rep_intake", cat: "Sales & Settings", emoji: "🏠", label: "Rep Intake Form", desc: "The homeowner sign-up form reps use in the field.", href: "/" },
  { key: "inspector_app", cat: "Sales & Settings", emoji: "📷", label: "Inspector App (admin)", desc: "The inspector mobile app with admin powers (switch user, etc.).", href: "/?mode=inspector&admin=1" },

  // ── Training (TMS) — the Training Management System's admin pages ──
  { key: "tms_home", cat: "Training (TMS)", emoji: "🎓", label: "Training Dashboard", desc: "The training home — classes and this week's cohort at a glance.", external: "https://trainingmanagementsys.netlify.app/" },
  { key: "tms_calendar", cat: "Training (TMS)", emoji: "📆", label: "Training Calendar", desc: "The class schedule — training weeks and days.", external: "https://trainingmanagementsys.netlify.app/calendar" },
  { key: "tms_progress", cat: "Training (TMS)", emoji: "📈", label: "Progress Funnel", desc: "Enrolled → registered → tested funnel per class.", external: "https://trainingmanagementsys.netlify.app/progress" },
  { key: "tms_attendance", cat: "Training (TMS)", emoji: "✅", label: "Attendance", desc: "Daily kiosk sign-ins per class.", external: "https://trainingmanagementsys.netlify.app/attendance" },
  { key: "tms_homework", cat: "Training (TMS)", emoji: "📝", label: "Homework Status", desc: "Who's done their homework, who to nudge.", external: "https://trainingmanagementsys.netlify.app/homework" },
  { key: "tms_provisioning", cat: "Training (TMS)", emoji: "🔧", label: "Provisioning", desc: "IT/HR/VA setup checklist per trainee (emails, RepCard, JN).", external: "https://trainingmanagementsys.netlify.app/provisioning" },
  { key: "tms_manager", cat: "Training (TMS)", emoji: "🧑‍💼", label: "Hiring Manager", desc: "Add trainees to a week, holding pool, reschedules.", external: "https://trainingmanagementsys.netlify.app/manager" },
  { key: "tms_active_reps", cat: "Training (TMS)", emoji: "👥", label: "Active Sales Reps", desc: "The durable field roster — the 'all reps' broadcast list.", external: "https://trainingmanagementsys.netlify.app/active-reps" },
  { key: "tms_regional_mgrs", cat: "Training (TMS)", emoji: "🗺️", label: "Regional Managers", desc: "Zone managers + their tokenized dashboard links.", external: "https://trainingmanagementsys.netlify.app/regional-managers" },
  { key: "tms_repmap", cat: "Training (TMS)", emoji: "📍", label: "Sales Team Map", desc: "Live map of the whole sales team.", external: "https://trainingmanagementsys.netlify.app/rep-map" },
  { key: "tms_regions", cat: "Training (TMS)", emoji: "🧭", label: "Zones", desc: "Manage regions/zones + map centers.", external: "https://trainingmanagementsys.netlify.app/regions" },
  { key: "tms_group_messages", cat: "Training (TMS)", emoji: "📣", label: "Group Messages", desc: "Broadcast SMS/email to a class or all active reps.", external: "https://trainingmanagementsys.netlify.app/group-messages" },
  { key: "tms_directory_admin", cat: "Training (TMS)", emoji: "📇", label: "Manage Directory", desc: "Edit the public team directory.", external: "https://trainingmanagementsys.netlify.app/manage-directory" },
  { key: "tms_directory", cat: "Training (TMS)", emoji: "📖", label: "Team Directory (public)", desc: "The public handoff-contact directory.", external: "https://trainingmanagementsys.netlify.app/directory" },
  { key: "tms_messages", cat: "Training (TMS)", emoji: "💬", label: "Messages", desc: "Every automated trainee/rep message.", external: "https://trainingmanagementsys.netlify.app/messages" },
  { key: "tms_notifications", cat: "Training (TMS)", emoji: "🔔", label: "Notifications", desc: "Who gets which office notification (SMS/email).", external: "https://trainingmanagementsys.netlify.app/notifications" },
  { key: "tms_templates", cat: "Training (TMS)", emoji: "🧩", label: "Message Templates", desc: "Edit the saved SMS/email templates.", external: "https://trainingmanagementsys.netlify.app/message-templates" },
  { key: "tms_handoff", cat: "Training (TMS)", emoji: "🤝", label: "Handoff Contacts", desc: "The vCard contacts new grads receive.", external: "https://trainingmanagementsys.netlify.app/handoff-contacts" },
  { key: "tms_personas", cat: "Training (TMS)", emoji: "🔐", label: "Personas", desc: "Role-based access — who sees which TMS pages.", external: "https://trainingmanagementsys.netlify.app/personas" },
  { key: "tms_hosted", cat: "Training (TMS)", emoji: "🌐", label: "Hosted Pages", desc: "Editable public pages.", external: "https://trainingmanagementsys.netlify.app/hosted-pages" },
  { key: "tms_locations", cat: "Training (TMS)", emoji: "🏫", label: "Locations", desc: "Training locations + photos.", external: "https://trainingmanagementsys.netlify.app/locations" },
  { key: "tms_hotels", cat: "Training (TMS)", emoji: "🏨", label: "Hotels", desc: "Trainee hotel booking + cancellations.", external: "https://trainingmanagementsys.netlify.app/hotels" },
  { key: "tms_welcome_links", cat: "Training (TMS)", emoji: "🔗", label: "Welcome Page Links", desc: "Links shown on the trainee welcome page.", external: "https://trainingmanagementsys.netlify.app/welcome-links" },
  { key: "tms_questions", cat: "Training (TMS)", emoji: "❓", label: "Test Questions", desc: "The final-test question bank.", external: "https://trainingmanagementsys.netlify.app/questions" },
  { key: "tms_testimonials", cat: "Training (TMS)", emoji: "⭐", label: "Testimonials", desc: "Trainee essay/testimonial answers.", external: "https://trainingmanagementsys.netlify.app/testimonials" },
  { key: "tms_training_week", cat: "Training (TMS)", emoji: "🗓️", label: "Training Week", desc: "The standard training-week template.", external: "https://trainingmanagementsys.netlify.app/training-week" },
  { key: "tms_ongoing", cat: "Training (TMS)", emoji: "🔁", label: "Ongoing Training", desc: "Post-grad ongoing training days.", external: "https://trainingmanagementsys.netlify.app/ongoing-training" },
  { key: "tms_field_trainee", cat: "Training (TMS)", emoji: "🚗", label: "Field Trainee", desc: "The field-training ride-along picker.", external: "https://trainingmanagementsys.netlify.app/field-trainee" },
  { key: "tms_overview", cat: "Training (TMS)", emoji: "🧾", label: "TMS System Overview", desc: "The whole training system explained on one page.", external: "https://trainingmanagementsys.netlify.app/system-overview.html" },

  // ── Other apps ──
  { key: "rep_dashboard", cat: "Other Apps", emoji: "📋", label: "Rep Dashboard", desc: "Daily schedule, standings, and training links for reps.", external: "https://us-shingle-rep-dashboard.netlify.app" },
  { key: "closesheet", cat: "Other Apps", emoji: "🧮", label: "Close Sheet", desc: "Enter measurements & pricing to generate the close pages.", external: "https://usshinglesalessheet.netlify.app" },
  { key: "forms", cat: "Other Apps", emoji: "📄", label: "U.S. Shingle Forms", desc: "Field forms — deposits, upgrades, and more.", external: "https://us-shingle-forms.netlify.app" },
  { key: "install_finder", cat: "Other Apps", emoji: "🧭", label: "Install Finder", desc: "Find past installs by city, radius, or statewide.", external: "https://golden-banoffee-56e9ef.netlify.app" },
  { key: "system_map", cat: "Other Apps", emoji: "🗺", label: "System Map", desc: "Interactive flow of the whole system — every text, email, JN push.", external: "/system-map.html" },
];

const CATS = ["Door-Knocking", "Inspections", "Public Adjuster", "Installs", "Sales & Settings", "Training (TMS)", "Other Apps"];
const byKey = Object.fromEntries(CATALOG.map((t) => [t.key, t]));

// palette
const NAVY = "#0f2a4a", RED = "#c0392b", INK = "#16233b", MUTE = "#5b6b8c", LINE = "#e2e8f2", BG = "#f4f7fb";

// ── Browser-tab names per ?mode (so a DoorDispatcher tab reads "DoorDispatcher", etc.).
// The office tools + rep-facing modes both get a name; anything unlisted keeps the default.
const MODE_TITLES = {
  mytools: "My Tools", harvest: "DoorDispatcher", canvass: "DoorDispatcher",
  harvestadmin: "Pin Types", harvestlinks: "Rep Links & Access", harvestreport: "Rep Activity",
  harvestupload: "Load Leads", scheduleadmin: "Appointment Scheduler", harvestjnsync: "JN Sync",
  harvesttrainingadmin: "Tool Training", harvesttraining: "Tool Training", harvestplannedday: "Planned Day",
  harvestnositreport: "No-Sits to Re-book", harvestskiptrace: "Skip-Trace", harvesthowtoadmin: "How-To Library",
  harvesthowto: "How-To", inspectmap: "Inspection Map", inspectorlinks: "Inspector Links",
  inspectvisitreport: "Inspector Activity", masterinspreport: "Master Inspection Reports",
  gobackschedule: "After-Inspection Scheduling", pareschedcompose: "Reschedule Composer",
  pareschedule: "Reschedule", installs: "Installs Map", foremanlinks: "Foreman Links",
  contest: "Contest Leaderboard", manager: "Manager Console", setter: "Setter Portal",
  crews: "Crew Onboarding", pa: "PA Portal", inspector: "Inspector App", admin: "Admin",
  roofmeasure: "Roof Measurement", rooftakeoff: "Roof Takeoff", masterinspreport2: "Reports",
};

// The catalog entry whose destination matches the page we're on now (matched by ?mode),
// so the floating "Add to my dashboard" button knows which tile to add.
function entryModeOf(t) {
  if (t.token === "harvest") return "harvest";
  if (t.token === "inspect") return "inspectmap";
  if (t.href && t.href.indexOf("/?mode=") === 0) { try { return new URLSearchParams(t.href.slice(1)).get("mode"); } catch { return null; } }
  return null;
}
function catalogEntryForCurrentUrl() {
  let mode = "";
  try { mode = new URLSearchParams(window.location.search).get("mode") || ""; } catch { return null; }
  if (!mode) return null;
  return CATALOG.find((t) => entryModeOf(t) === mode) || null;
}

// Root-level overlay (mounted next to <App/>): names the browser tab after the current
// tool, and — for an office/admin person already signed into My Tools on this device —
// shows a floating "➕ Add to my dashboard" button on any CCG tool page, so they can build
// their dashboard just by visiting a tool and tapping the button.
export function MyToolsOverlay() {
  const [me, setMe] = useState(null);          // { name, pin }
  const [entry, setEntry] = useState(null);    // matched catalog entry
  const [tools, setTools] = useState(null);    // their current saved keys
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // 1) Tab title.
    try {
      const mode = new URLSearchParams(window.location.search).get("mode") || "";
      const title = MODE_TITLES[mode];
      if (title) document.title = `${title} · U.S. Shingle`;
    } catch { /* ignore */ }
    // 2) Add-to-dashboard eligibility: signed into My Tools + current page is a catalog tool.
    let name = "", pin = "";
    try { name = localStorage.getItem("ccg_mytools_name") || ""; pin = localStorage.getItem("ccg_mytools_pin") || ""; } catch { /* private */ }
    if (!name || !pin) return;
    const e = catalogEntryForCurrentUrl();
    if (!e) return;
    setMe({ name, pin }); setEntry(e);
    fetch(`${API}?manager=${encodeURIComponent(name)}`).then((r) => r.json()).then((d) => {
      setTools(Array.isArray(d.tools) ? d.tools : []);
    }).catch(() => setTools([]));
  }, []);

  if (!me || !entry || tools === null) return null;
  const added = tools.includes(entry.key);
  const add = async () => {
    if (added || saving) return;
    setSaving(true);
    const next = [...new Set([...tools, entry.key])];
    try {
      await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", pin: me.pin, manager: me.name, tools: next }) });
      setTools(next);
    } catch { /* leave as-is */ }
    setSaving(false);
  };
  return (
    <div style={{ position: "fixed", left: 12, bottom: 12, zIndex: 2147483000 }}>
      <button onClick={add} disabled={added || saving}
        title={added ? "This tool is on your My Tools dashboard" : `Add ${entry.label} to your My Tools dashboard`}
        style={{ display: "flex", alignItems: "center", gap: 7, border: "none", borderRadius: 999,
          padding: "10px 15px", fontSize: 13.5, fontWeight: 800, cursor: added ? "default" : "pointer",
          fontFamily: '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
          background: added ? "#16a34a" : NAVY, color: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,.28)", opacity: saving ? 0.6 : 1 }}>
        {added ? "✓ On your dashboard" : (saving ? "Adding…" : "➕ Add to my dashboard")}
      </button>
    </div>
  );
}

export default function MyToolsPage() {
  const [step, setStep] = useState("loading"); // loading | pick | pin | dash
  const [users, setUsers] = useState(null);     // JN users for the name typeahead (null = not loaded)
  const [q, setQ] = useState("");               // typeahead query on the pick screen
  const [name, setName] = useState(() => { try { return localStorage.getItem("ccg_mytools_name") || ""; } catch { return ""; } });
  const [pin, setPin] = useState("");
  const [pinSet, setPinSet] = useState(true);
  const [tools, setTools] = useState([]);       // saved keys for this manager
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);       // working set while editing
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [adminTok, setAdminTok] = useState(null);

  // On load: learn whether a PIN exists yet, and (if a name+pin are remembered)
  // jump straight to the dashboard.
  useEffect(() => {
    let alive = true;
    (async () => {
      let remembered = "";
      try { remembered = localStorage.getItem("ccg_mytools_pin") || ""; } catch { /* private */ }
      try {
        const r = await fetch(API);
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        setPinSet(!!(d && d.pin_set));
        if (name && remembered && d && d.pin_set) {
          setPin(remembered);
          await loadTools(name, remembered, true);
          return;
        }
      } catch { /* fall through to pick */ }
      if (alive) setStep(name ? "pin" : "pick");
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the JN user list once we land on the name-pick screen (for the typeahead).
  useEffect(() => {
    if (step !== "pick" || users !== null) return;
    (async () => {
      try {
        const r = await fetch(JN_USERS_API);
        const d = await r.json().catch(() => ({}));
        setUsers(Array.isArray(d.members) ? d.members : []);
      } catch { setUsers([]); }
    })();
  }, [step, users]);

  // The two office-map tools need the harvest admin token. Fetch it once we're in.
  useEffect(() => {
    if (step !== "dash" || adminTok !== null) return;
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "harvest_admin_token").maybeSingle();
        setAdminTok(data?.value || "");
      } catch { setAdminTok(""); }
    })();
  }, [step, adminTok]);

  async function loadTools(mgr, thePin, silent) {
    if (!silent) setBusy(true);
    setErr("");
    try {
      // Validate the PIN (also sets it the very first time) via a lightweight auth.
      const a = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "auth", pin: thePin }) });
      const ad = await a.json().catch(() => ({}));
      if (!a.ok || !ad.ok) { setBusy(false); setErr(ad.error || "Incorrect PIN."); setStep("pin"); return false; }
      const r = await fetch(`${API}?manager=${encodeURIComponent(mgr)}`);
      const d = await r.json().catch(() => ({}));
      const keys = Array.isArray(d.tools) ? d.tools.filter((k) => byKey[k]) : [];
      setTools(keys);
      setPinSet(true);
      try { localStorage.setItem("ccg_mytools_name", mgr); localStorage.setItem("ccg_mytools_pin", thePin); } catch { /* private */ }
      setStep("dash");
      setBusy(false);
      return true;
    } catch {
      setBusy(false); setErr("Couldn't reach the server. Try again."); return false;
    }
  }

  async function saveTools(keys) {
    setTools(keys);
    try {
      await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", pin, manager: name, tools: keys }) });
    } catch { /* keep local copy; retry on next save */ }
  }

  function openTool(t) {
    let url = t.href || t.external || "/";
    if (t.token === "harvest") url = adminTok ? `/?mode=harvest&admin=${encodeURIComponent(adminTok)}` : "/?mode=harvestlinks";
    if (t.token === "inspect") url = adminTok ? `/?mode=inspectmap&admin=${encodeURIComponent(adminTok)}` : "/?mode=inspectmap";
    window.open(url, "_blank", "noopener");
  }

  function signOut() {
    try { localStorage.removeItem("ccg_mytools_name"); localStorage.removeItem("ccg_mytools_pin"); } catch { /* private */ }
    setName(""); setPin(""); setTools([]); setStep("pick");
  }

  // ---------- screens ----------
  if (step === "loading") return <Shell><div style={{ textAlign: "center", color: MUTE, padding: "60px 0" }}>Loading…</div></Shell>;

  if (step === "pick") {
    const term = q.trim().toLowerCase();
    const matches = term.length < 2 ? [] : (users || [])
      .filter((u) => u.name.toLowerCase().includes(term))
      .slice(0, 8);
    return (
      <Shell>
        <Header sub="Type your name and tap it to open your dashboard." />
        <div style={{ marginTop: 18, maxWidth: 460 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder={users === null ? "Loading names…" : "Start typing your name…"}
            disabled={users === null}
            style={{ width: "100%", boxSizing: "border-box", fontSize: 16, padding: "12px 14px", border: `1.5px solid ${LINE}`, borderRadius: 12, outline: "none" }} />
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {matches.map((u) => (
              <button key={u.jobnimbus_id} onClick={() => { setName(u.name); setErr(""); setStep("pin"); }} style={pickBtn}>
                <span style={{ fontWeight: 800, color: NAVY, fontSize: 15.5 }}>{u.name}</span>
                {u.email ? <span style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>{u.email}</span> : null}
              </button>
            ))}
            {term.length >= 2 && users && matches.length === 0 ? (
              <div style={{ fontSize: 13.5, color: MUTE, padding: "8px 2px" }}>No JobNimbus user matches “{q.trim()}”. Check the spelling, or ask the office to confirm your JN account.</div>
            ) : null}
          </div>
        </div>
      </Shell>
    );
  }

  if (step === "pin") {
    const first = !pinSet;
    return (
      <Shell>
        <Header sub={<>Signing in as <b style={{ color: NAVY }}>{name}</b>. <button onClick={() => setStep("pick")} style={linkBtn}>change</button></>} />
        <div style={{ marginTop: 20, maxWidth: 340 }}>
          <div style={{ fontWeight: 800, color: NAVY, marginBottom: 6 }}>{first ? "Set the manager PIN" : "Enter the manager PIN"}</div>
          <div style={{ fontSize: 12.5, color: MUTE, marginBottom: 12 }}>
            {first ? "No PIN yet — the first one entered becomes the shared manager PIN for the team." : "The shared manager PIN."}
          </div>
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric" type="password" placeholder="••••" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && pin.length >= 4) loadTools(name, pin); }}
            style={pinInput} />
          {err ? <div style={{ color: RED, fontSize: 13, marginTop: 8 }}>{err}</div> : null}
          <button disabled={busy || pin.length < 4} onClick={() => loadTools(name, pin)}
            style={{ ...primaryBtn, marginTop: 14, opacity: busy || pin.length < 4 ? 0.5 : 1 }}>
            {busy ? "Checking…" : first ? "Set PIN & continue" : "Open my dashboard"}
          </button>
        </div>
      </Shell>
    );
  }

  // dashboard
  const myTools = tools.map((k) => byKey[k]).filter(Boolean);
  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: RED }}>U.S. Shingle &amp; Metal</div>
          <h1 style={{ fontSize: 23, margin: "3px 0 0", color: NAVY }}>{name.split(" ")[0]}'s Tools</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setDraft(tools); setEditing(true); }} style={ghostBtn}>⚙️ Customize</button>
          <button onClick={signOut} style={{ ...ghostBtn, color: MUTE }}>Switch user</button>
        </div>
      </div>
      <div style={{ height: 3, width: 60, background: RED, borderRadius: 2, margin: "12px 0 18px" }} />

      {myTools.length === 0 ? (
        <div style={{ background: "#fff8f0", border: `1px solid #f3d4a8`, borderRadius: 14, padding: "22px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 34 }}>🧰</div>
          <div style={{ fontWeight: 800, color: NAVY, marginTop: 6 }}>Your dashboard is empty</div>
          <div style={{ fontSize: 13.5, color: MUTE, margin: "6px 0 14px" }}>Add the tools you use — you can change this anytime.</div>
          <button onClick={() => { setDraft(tools); setEditing(true); }} style={primaryBtn}>➕ Add your tools</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {myTools.map((t) => (
            <button key={t.key} onClick={() => openTool(t)} style={toolCard}>
              <div style={{ fontSize: 26 }}>{t.emoji}</div>
              <div style={{ fontWeight: 800, color: NAVY, fontSize: 14.5, marginTop: 6 }}>{t.label}</div>
              <div style={{ fontSize: 12, color: MUTE, marginTop: 3, lineHeight: 1.4 }}>{t.desc}</div>
            </button>
          ))}
        </div>
      )}

      {editing ? (
        <Customizer draft={draft} setDraft={setDraft}
          onClose={() => setEditing(false)}
          onSave={async () => { await saveTools(draft); setEditing(false); }} />
      ) : null}
    </Shell>
  );
}

// ---------- customizer overlay ----------
function Customizer({ draft, setDraft, onClose, onSave }) {
  const [q, setQ] = useState("");
  const has = (k) => draft.includes(k);
  const toggle = (k) => setDraft(has(k) ? draft.filter((x) => x !== k) : [...draft, k]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return CATALOG.filter((t) => !s || (t.label + " " + t.desc).toLowerCase().includes(s));
  }, [q]);
  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, color: NAVY, fontSize: 18 }}>Customize your dashboard</div>
            <div style={{ fontSize: 12.5, color: MUTE }}>Tap a tool to add or remove it. {draft.length} selected.</div>
          </div>
          <button onClick={onSave} style={primaryBtn}>Save</button>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" style={searchInput} />
        <div style={{ overflowY: "auto", marginTop: 12, paddingRight: 4 }}>
          {CATS.map((cat) => {
            const items = filtered.filter((t) => t.cat === cat);
            if (!items.length) return null;
            return (
              <div key={cat} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: MUTE, margin: "0 0 8px" }}>{cat}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
                  {items.map((t) => {
                    const on = has(t.key);
                    return (
                      <button key={t.key} onClick={() => toggle(t.key)}
                        style={{ ...pickTool, borderColor: on ? "#16a34a" : LINE, background: on ? "#f0f9f2" : "#fff" }}>
                        <span style={{ fontSize: 20, flex: "none" }}>{t.emoji}</span>
                        <span style={{ flex: 1, textAlign: "left" }}>
                          <span style={{ display: "block", fontWeight: 700, color: NAVY, fontSize: 13.5 }}>{t.label}</span>
                          <span style={{ display: "block", fontSize: 11.5, color: MUTE, lineHeight: 1.35, marginTop: 1 }}>{t.desc}</span>
                        </span>
                        <span style={{ flex: "none", fontSize: 18, color: on ? "#16a34a" : "#cbd5e1", fontWeight: 800 }}>{on ? "✓" : "＋"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- chrome ----------
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif', color: INK }}>
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "26px 18px 60px" }}>{children}</div>
    </div>
  );
}
function Header({ sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: RED }}>U.S. Shingle &amp; Metal · Office / Admin</div>
      <h1 style={{ fontSize: 26, margin: "4px 0 0", color: NAVY }}>My Tools</h1>
      <div style={{ height: 3, width: 60, background: RED, borderRadius: 2, margin: "11px 0 0" }} />
      {sub ? <div style={{ fontSize: 14, color: MUTE, marginTop: 12 }}>{sub}</div> : null}
    </div>
  );
}

// ---------- styles ----------
const pickBtn = { display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: "15px 18px", cursor: "pointer", boxShadow: "0 1px 2px rgba(15,42,74,.05)" };
const pinInput = { width: "100%", fontSize: 24, letterSpacing: "0.3em", textAlign: "center", padding: "12px 14px", border: `1.5px solid ${LINE}`, borderRadius: 12, outline: "none" };
const primaryBtn = { background: NAVY, color: "#fff", border: "none", borderRadius: 11, padding: "11px 18px", fontWeight: 800, fontSize: 14, cursor: "pointer" };
const ghostBtn = { background: "#fff", color: NAVY, border: `1px solid ${LINE}`, borderRadius: 11, padding: "9px 14px", fontWeight: 700, fontSize: 13.5, cursor: "pointer" };
const linkBtn = { background: "none", border: "none", color: RED, fontWeight: 700, cursor: "pointer", padding: 0, fontSize: 13.5, textDecoration: "underline" };
const toolCard = { display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: "16px 16px", cursor: "pointer", boxShadow: "0 1px 3px rgba(15,42,74,.06)" };
const overlay = { position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50, padding: "0" };
const sheet = { background: BG, width: "100%", maxWidth: 940, maxHeight: "88vh", borderRadius: "18px 18px 0 0", padding: "18px 18px 26px", display: "flex", flexDirection: "column", boxShadow: "0 -8px 40px rgba(0,0,0,.25)" };
const pickTool = { display: "flex", alignItems: "flex-start", gap: 9, border: `1.5px solid ${LINE}`, borderRadius: 12, padding: "10px 12px", cursor: "pointer", background: "#fff" };
const searchInput = { width: "100%", fontSize: 14, padding: "10px 14px", border: `1.5px solid ${LINE}`, borderRadius: 11, outline: "none" };
