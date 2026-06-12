// Shared date formatting helpers.

// Format a "signed" timestamp as date + time in Eastern.
// Imported / legacy records that only carry a calendar date are stored at
// midnight — for those we show the date alone (no fake "12:00 AM"), since
// no real clock time was ever captured. Records with a true sign time show
// e.g. "Jun 9, 2025, 2:45 PM".
export function fmtSigned(iso, { withYear = true } = {}) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dateOpts = { timeZone: "America/New_York", month: "short", day: "numeric" };
  if (withYear) dateOpts.year = "numeric";
  const date = new Intl.DateTimeFormat("en-US", dateOpts).format(d);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  if (hm === "00:00" || hm === "24:00") return date;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
  return `${date}, ${time}`;
}
