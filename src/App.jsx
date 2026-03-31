import React, { useEffect, useRef, useState } from "react";
import html2pdf from "html2pdf.js/dist/html2pdf";
import {
  ArrowLeft,
  FileSignature,
  Mail,
  RotateCcw,
  Send,
} from "lucide-react";
import { supabase } from "./lib/supabase";

// Inject Oswald font
if (typeof document !== "undefined" && !document.getElementById("oswald-font")) {
  const link = document.createElement("link");
  link.id = "oswald-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Nunito:wght@400;500;600;700&display=swap";
  document.head.appendChild(link);
}

const PA_FIXED = {
  name: "Benito Paul",
  initials: "BP",
  license: "P199496",
  signatureImage: "/benito-signature.png",
};

const PA_ASSETS = {
  header: "/pa-header.png",
  footer: "/pa-footer.png",
  titleBar: "/pa-titlebar.png",
};

const REP_FIXED = {
  name: "Neal Scoppe",
  signatureImage: "/rep-signature.png",
};

const INSPECTION_COMPANY = {
  name: "U.S. Shingle & Metal LLC",
  address: "3845 Gateway Centre Blvd Suite 300 • Pinellas Park, FL 33782",
  phone: "727.761.5200",
  email: "info@shingleusa.com",
  license: "CCC1331960",
};

const VALID_DOCS = ["insp", "lor", "pac"];

const SIGNATURE_FONTS = [
  `"Brush Script MT", cursive`,
  `"Segoe Script", cursive`,
  `"Lucida Handwriting", cursive`,
];

const PDF_LAYOUT = {
  headerHeight: "1.28in",
  footerHeight: "0.82in",
};

const REVIEW_INTRO_TEXT =
  "Two quick documents stand between you and getting your claim moving.";

const LOR_REVIEW_TEXT =
  'First is the “Letter of Representation” which simply tells your insurance company that you’ve hired a Public Adjuster.';

const PAC_REVIEW_TEXT =
  'The second is the “Public Adjuster Authorization” which is the authorization between you and the Public Adjuster.';

const REVIEW_HELP_TEXT =
  "Preview each document first if you'd like, then click 'Click to Authorize' for both before signing.";

const initialData = {
  date: new Date().toISOString().split("T")[0],
  insuranceCompany: "",
  policyNumber: "",
  lossLocation: "",
  lossLocationSameAsAddress: true,
  signerEmail: "",
  paEmail: "claims@iambenitopaul.com",
  representativeName: "",
  leadSource: "NEED",  // "NEED" | "INS"
  salesRepId: "",
  salesRepName: "",
  salesRepEmail: "",
  homeowner1: "",
  homeowner2: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  situation: "",
  claimStage: "pre_inspection", // "pre_inspection" | "post_inspection"
  dateOfLoss: "",
  claimNumber: "",
  claimType: "Wind/Hail",
  lossDescription: "Roof",
  initials1: "",
  initials2: "",
};

const initialAuditInfo = {
  signedAt: "",
  signedIp: "",
  signedUserAgent: "",
  signMethod: "",
  signedByEmail: "",
  signedByName: "",
  signedCity: "",
  signedRegion: "",
};

function documentLabel(doc) {
  if (doc === "pac") return "PA Authorization";
  if (doc === "insp") return "Free Roof Inspection";
  return "Letter of Representation";
}

function documentFilename(doc) {
  if (doc === "pac") return "Public-Adjuster-Authorization.pdf";
  if (doc === "insp") return "Free-Roof-Inspection-Agreement.pdf";
  return "Letter-of-Representation.pdf";
}

function formatAddress(data) {
  return [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

function typedSignatureToDataUrl(text, fontFamily, width = 500, height = 140) {
  if (!String(text || "").trim()) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111827";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `42px ${fontFamily}`;
  ctx.fillText(text, width / 2, height / 2);
  return canvas.toDataURL("image/png");
}

function typedInitialsToDataUrl(text, fontFamily, width = 220, height = 70) {
  if (!String(text || "").trim()) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111827";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `30px ${fontFamily}`;
  ctx.fillText(text, width / 2, height / 2);
  return canvas.toDataURL("image/png");
}

function DuplicateScreen({ duplicateRecord, signMode, signerEmail, onGoBack, onProceedAnyway, onResend }) {
  const rec = duplicateRecord.record;
  const isSigned = duplicateRecord.status === "signed";
  const isInsp = duplicateRecord.type === "inspection";
  const name = isInsp ? rec.client_name : [rec.homeowner1, rec.homeowner2].filter(Boolean).join(" & ");
  const addr = [rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ");
  const signedDate = rec.signed_at ? new Date(rec.signed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "40px 20px" }}>
      {/* Banner */}
      <div style={{
        background: isSigned ? "linear-gradient(135deg, #1a2e5a 0%, #0f1e3d 100%)" : "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
        borderRadius: 24, padding: "32px 28px", textAlign: "center", color: "#fff", marginBottom: 20,
      }}>
        <div style={{ fontSize: 52, marginBottom: 10 }}>{isSigned ? "⚠️" : "📨"}</div>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>
          {isSigned ? "Already Signed Up!" : "Documents Already Sent"}
        </div>
        <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
          {isSigned
            ? `This address already has ${isInsp ? "an inspection agreement" : "signed PA documents"} on file.`
            : "Documents were sent to this address but haven't been signed yet."}
        </div>
      </div>

      {/* Details card */}
      <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px", marginBottom: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>
          Existing Record
        </div>
        <div style={{ display: "grid", gap: 8, fontSize: 14, fontFamily: "'Nunito', sans-serif" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Name:</span>
            <span style={{ fontWeight: 700, color: "#111827" }}>{name || "—"}</span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Address:</span>
            <span style={{ fontWeight: 600, color: "#374151" }}>{addr || "—"}</span>
          </div>
          {isInsp && rec.sales_rep_name ? (
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Rep:</span>
              <span style={{ fontWeight: 600, color: "#374151" }}>{rec.sales_rep_name}</span>
            </div>
          ) : null}
          {signedDate ? (
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Signed:</span>
              <span style={{ fontWeight: 600, color: "#374151" }}>{signedDate}</span>
            </div>
          ) : null}
          {!isSigned ? (
            <div style={{ marginTop: 6, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#92400e", fontWeight: 600 }}>
              ⏳ Sent but not yet signed — you can resend the link without creating a duplicate.
            </div>
          ) : null}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "grid", gap: 10 }}>
        {!isSigned ? (
          /* Pending — offer to resend */
          <button type="button" onClick={onResend}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            📨 Resend Signing Link
          </button>
        ) : null}

        {isSigned && signMode !== "send" ? (
          /* Already signed + sign-now mode — can still proceed if it's a different form */
          <button type="button" onClick={onProceedAnyway}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#6b7280", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            ⚠️ Sign Anyway (Different Forms)
          </button>
        ) : null}

        {isSigned && signMode === "send" ? (
          <button type="button" onClick={onProceedAnyway}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#6b7280", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            ⚠️ Send Anyway (Different Forms)
          </button>
        ) : null}

        <button type="button" onClick={onGoBack}
          style={{ padding: "14px", borderRadius: 14, border: "2px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
          ← Go Back
        </button>
      </div>
    </div>
  );
}

function SendingScreen({ onMount }) {
  const calledRef = React.useRef(false);
  React.useEffect(() => {
    if (!calledRef.current) { calledRef.current = true; onMount(); }
  }, []);
  return (
    <div style={{ maxWidth: 440, margin: "80px auto", padding: "0 20px", textAlign: "center" }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>📨</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#199c2e", marginBottom: 10 }}>
        Sending...
      </div>
      <div style={{ fontSize: 15, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
        Saving record and sending signing link to homeowner.
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  disabled = false,
  style: overrideStyle = {},
}) {
  const baseStyle = {
    height: 48,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid #d1d5db",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: disabled ? 0.6 : 1,
    transition: "background 0.2s, border-color 0.2s",
  };

  const styles =
    variant === "outline"
      ? {
          ...baseStyle,
          background: "#fff",
          color: "#111827",
          ...overrideStyle,
        }
      : {
          ...baseStyle,
          background: "#199c2e",
          color: "#fff",
          border: "1px solid #199c2e",
          ...overrideStyle,
        };

  return (
    <button type={type} onClick={onClick} style={styles} disabled={disabled}>
      {children}
    </button>
  );
}

function Card({ children, style = {} }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 24,
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        border: "1px solid #e5e7eb",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ children }) {
  return <div style={{ padding: 24, paddingBottom: 12 }}>{children}</div>;
}

function CardTitle({ children }) {
  return (
    <div style={{ fontSize: 30, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>
      {children}
    </div>
  );
}

function CardDescription({ children }) {
  return (
    <div style={{ fontSize: 16, color: "#6b7280", marginTop: 8, fontFamily: "'Nunito', sans-serif", fontWeight: 500, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function CardContent({ children }) {
  return <div style={{ padding: 24, paddingTop: 12 }}>{children}</div>;
}

function Label({ children }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 14,
        color: "#374151",
        marginBottom: 8,
        fontWeight: 600,
        fontFamily: "'Nunito', sans-serif",
      }}
    >
      {children}
    </label>
  );
}

function SectionTitle({ children }) {
  return (
    <div
      style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#111827",
        marginBottom: 14,
        fontFamily: "'Oswald', sans-serif",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Separator() {
  return (
    <div
      style={{
        width: "100%",
        height: 1,
        background: "#e5e7eb",
        margin: "8px 0",
      }}
    />
  );
}

function FormField({
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
  disabled = false,
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 14,
          border: "1px solid #d1d5db",
          padding: "0 12px",
          fontSize: 14,
          boxSizing: "border-box",
          background: disabled ? "#f3f4f6" : "#fff",
        }}
      />
    </div>
  );
}

function CheckboxField({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 14,
        color: "#374151",
        fontWeight: 500,
        marginBottom: 8,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16 }}
      />
      {label}
    </label>
  );
}

function SignaturePad({
  title,
  value,
  onChange,
  height = 160,
  required = false,
  missing = false,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
    }
  }, [value]);

  const getPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };

  const start = (e) => {
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
  };

  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    onChange("");
  };

  const isEmpty = !value;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Outer card */}
      <div style={{
        borderRadius: 20,
        border: missing
          ? "2.5px solid #ef4444"
          : isEmpty
            ? "2.5px dashed #199c2e"
            : "2.5px solid #199c2e",
        background: missing ? "#fef2f2" : "#f0fdf4",
        overflow: "hidden",
        boxShadow: missing
          ? "0 0 0 4px rgba(239,68,68,0.08)"
          : isEmpty
            ? "0 0 0 4px rgba(25,156,46,0.08)"
            : "0 0 0 4px rgba(25,156,46,0.12)",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}>
        {/* Hint bar at top */}
        {isEmpty ? (
          <div style={{
            background: "#199c2e",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <span style={{
              color: "#fff",
              fontSize: 13,
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
            }}>
              ✍️ Sign in the box below
            </span>
            <span style={{
              color: "rgba(255,255,255,0.8)",
              fontSize: 12,
              fontFamily: "'Nunito', sans-serif",
            }}>
              Use finger or mouse
            </span>
          </div>
        ) : (
          <div style={{
            background: "#15803d",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <span style={{
              color: "#fff",
              fontSize: 13,
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
            }}>
              ✅ Signature captured!
            </span>
            <button
              type="button"
              onClick={clear}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: 8,
                color: "#fff",
                fontSize: 12,
                fontFamily: "'Nunito', sans-serif",
                fontWeight: 700,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              ↺ Redo
            </button>
          </div>
        )}

        {/* Canvas area */}
        <div style={{ position: "relative", background: "#fff" }}>
          {isEmpty ? (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              userSelect: "none",
            }}>
              <span style={{
                fontSize: 15,
                color: "#d1d5db",
                fontFamily: "'Nunito', sans-serif",
                fontStyle: "italic",
                fontWeight: 600,
              }}>
                Your signature here...
              </span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height,
              display: "block",
              touchAction: "none",
              cursor: "crosshair",
            }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
          {/* Signature line */}
          <div style={{
            position: "absolute",
            bottom: 24,
            left: "10%",
            right: "10%",
            height: 1,
            background: "#e5e7eb",
            pointerEvents: "none",
          }} />
        </div>
      </div>

      {missing ? (
        <div style={{
          color: "#ef4444",
          fontSize: 13,
          marginTop: 8,
          fontFamily: "'Nunito', sans-serif",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}>
          ⚠️ Please add your signature above
        </div>
      ) : null}
    </div>
  );
}

function InitialsPad({
  title,
  value,
  onChange,
  required = false,
  missing = false,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
    }
  }, [value]);

  const getPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };

  const start = (e) => {
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
  };

  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    onChange("");
  };

  const isEmpty = !value;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        borderRadius: 16,
        border: missing
          ? "2.5px solid #ef4444"
          : isEmpty
            ? "2.5px dashed #199c2e"
            : "2.5px solid #199c2e",
        background: missing ? "#fef2f2" : "#fff",
        overflow: "hidden",
        boxShadow: missing
          ? "0 0 0 3px rgba(239,68,68,0.08)"
          : isEmpty
            ? "0 0 0 3px rgba(25,156,46,0.08)"
            : "0 0 0 3px rgba(25,156,46,0.12)",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}>
        {/* Top label bar */}
        <div style={{
          background: isEmpty ? "#f0fdf4" : "#15803d",
          padding: "6px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: isEmpty ? "1px solid #bbf7d0" : "none",
        }}>
          <span style={{
            fontSize: 12,
            fontFamily: "'Nunito', sans-serif",
            fontWeight: 700,
            color: isEmpty ? "#166534" : "#fff",
          }}>
            {isEmpty ? "✏️ Initials here" : "✅ Initials captured!"}
          </span>
          {!isEmpty ? (
            <button
              type="button"
              onClick={clear}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 11,
                fontFamily: "'Nunito', sans-serif",
                fontWeight: 700,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              ↺ Redo
            </button>
          ) : null}
        </div>

        {/* Canvas */}
        <div style={{ position: "relative", background: "#fff" }}>
          {isEmpty ? (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              userSelect: "none",
            }}>
              <span style={{
                fontSize: 13,
                color: "#d1d5db",
                fontFamily: "'Nunito', sans-serif",
                fontStyle: "italic",
                fontWeight: 600,
              }}>e.g. JD</span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height: 52,
              display: "block",
              touchAction: "none",
              cursor: "crosshair",
            }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
        </div>
      </div>

      {missing ? (
        <div style={{
          color: "#ef4444",
          fontSize: 13,
          marginTop: 6,
          fontFamily: "'Nunito', sans-serif",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}>
          ⚠️ Please add your initials above
        </div>
      ) : null}
    </div>
  );
}

function TypedSignatureField({
  title,
  value,
  onChange,
  fontValue,
  onFontChange,
  required = false,
  missing = false,
  placeholder,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>
        {title}
        {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
      </Label>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 12,
          border: missing ? "2px solid #dc2626" : "1px solid #d1d5db",
          padding: "0 12px",
          marginBottom: 10,
          boxSizing: "border-box",
          background: missing ? "#fef2f2" : "#fff",
        }}
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {SIGNATURE_FONTS.map((font, idx) => (
          <button
            key={font}
            type="button"
            onClick={() => onFontChange(font)}
            style={{
              border:
                fontValue === font
                  ? "2px solid #111827"
                  : "1px solid #d1d5db",
              borderRadius: 10,
              background: "#fff",
              cursor: "pointer",
              padding: "10px 14px",
              fontSize: 22,
              fontFamily: font,
            }}
          >
            {value || `Style ${idx + 1}`}
          </button>
        ))}
      </div>

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
        </div>
      ) : null}
    </div>
  );
}

function TypedInitialsField({
  title,
  value,
  onChange,
  fontValue,
  onFontChange,
  required = false,
  missing = false,
  placeholder,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>
        {title}
        {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
      </Label>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 12,
          border: missing ? "2px solid #dc2626" : "1px solid #d1d5db",
          padding: "0 12px",
          marginBottom: 10,
          boxSizing: "border-box",
          background: missing ? "#fef2f2" : "#fff",
        }}
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {SIGNATURE_FONTS.map((font, idx) => (
          <button
            key={font}
            type="button"
            onClick={() => onFontChange(font)}
            style={{
              border:
                fontValue === font
                  ? "2px solid #111827"
                  : "1px solid #d1d5db",
              borderRadius: 10,
              background: "#fff",
              cursor: "pointer",
              padding: "10px 14px",
              fontSize: 18,
              fontFamily: font,
            }}
          >
            {value || `Style ${idx + 1}`}
          </button>
        ))}
      </div>

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
        </div>
      ) : null}
    </div>
  );
}

function PdfPage({
  children,
  header,
  footer,
  isExportingPdf = false,
  contentPadding = "0 0.42in 0.12in",
  headerHeight = PDF_LAYOUT.headerHeight,
  footerHeight = PDF_LAYOUT.footerHeight,
}) {
  if (isExportingPdf) {
    return (
      <div
        className="pdf-page"
        style={{
          position: "relative",
          width: "8.5in",
          height: "11in",
          background: "#fff",
          boxSizing: "border-box",
          overflow: "hidden",
          fontFamily: "Arial, Helvetica, sans-serif",
          color: "#111827",
        }}
      >
        {header ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: headerHeight,
              lineHeight: 0,
              overflow: "hidden",
            }}
          >
            {header}
          </div>
        ) : null}

        {footer ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: footerHeight,
              lineHeight: 0,
              overflow: "hidden",
            }}
          >
            {footer}
          </div>
        ) : null}

        <div
          style={{
            position: "absolute",
            top: header ? headerHeight : 0,
            left: 0,
            right: 0,
            bottom: footer ? footerHeight : 0,
            boxSizing: "border-box",
            padding: contentPadding,
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      className="pdf-page"
      style={{
        background: "#fff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        overflow: "hidden",
        marginBottom: 16,
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      {header ? <div style={{ lineHeight: 0 }}>{header}</div> : null}
      <div style={{ padding: contentPadding }}>{children}</div>
      {footer ? <div style={{ lineHeight: 0 }}>{footer}</div> : null}
    </div>
  );
}

function AuditTrailPage({
  auditInfo,
  data,
  docLabel,
  claimId,
  isExportingPdf = false,
}) {
  if (!auditInfo?.signedAt) return null;

  const rows = [
    ["Document", docLabel],
    ["Claim ID", claimId || "Not available"],
    [
      "Signed by",
      auditInfo.signedByName ||
        [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
    ],
    ["Signer email", auditInfo.signedByEmail || data.signerEmail],
    ["Signed at", auditInfo.signedAt],
    ["IP address", auditInfo.signedIp],
    ...(auditInfo.signedCity || auditInfo.signedRegion
      ? [[
          "City / State",
          [auditInfo.signedCity, auditInfo.signedRegion]
            .filter(Boolean)
            .join(", "),
        ]]
      : []),
    ["Sign method", auditInfo.signMethod],
    ["Browser / device", auditInfo.signedUserAgent],
  ];

  return (
    <div
      className="pdf-page"
      style={
        isExportingPdf
          ? {
              width: "8.5in",
              height: "11in",
              background: "#fff",
              boxSizing: "border-box",
              overflow: "hidden",
              fontFamily: "Arial, Helvetica, sans-serif",
              color: "#111827",
            }
          : {
              background: "#fff",
              borderRadius: 24,
              border: "1px solid #e5e7eb",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
              overflow: "hidden",
              marginBottom: 16,
              fontFamily: "Arial, Helvetica, sans-serif",
              color: "#111827",
            }
      }
    >
      <div
        style={{
          padding: "0.55in 0.6in",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 10 }}>
          Signature Acknowledgment
        </div>

        <div style={{ fontSize: 14, color: "#4b5563", marginBottom: 24 }}>
          Electronic signing audit trail for this document.
        </div>

        <div
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          {rows.map(([label, value], i) => (
            <div
              key={label}
              style={{
                display: "grid",
                gridTemplateColumns: "200px 1fr",
                borderTop: i === 0 ? "none" : "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  background: "#f8fafc",
                  padding: "14px 16px",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  padding: "14px 16px",
                  fontSize: 13,
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                }}
              >
                {value || "Not available"}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 24,
            border: "1px solid #d1d5db",
            borderRadius: 16,
            padding: 18,
            background: "#f8fafc",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          By signing electronically, the signer acknowledged intent to sign this
          document and submitted the signature using the browser session that
          generated the audit information shown above.
        </div>
      </div>
    </div>
  );
}


function LetterOfRepresentation({
  data,
  sig1,
  sig2,
  auditInfo,
  claimId,
  isExportingPdf = false,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const fullAddress = formatAddress(data);
  const displayedLossLocation = data.lossLocationSameAsAddress
    ? fullAddress
    : data.lossLocation;

  const HeaderImg = () => (
    <img
      src={PA_ASSETS.header}
      alt="Capital Claims Group header"
      style={{ width: "100%", display: "block" }}
    />
  );

  const FooterImg = () => (
    <img
      src={PA_ASSETS.footer}
      alt="Capital Claims Group footer"
      style={{ width: "100%", display: "block" }}
    />
  );

  const LorTitleBar = () => (
    <div
      style={{
        margin: "10px 0 12px",
        background: "#199c2e",
        color: "#fff",
        textAlign: "center",
        fontWeight: 700,
        fontSize: 20,
        letterSpacing: 1,
        padding: "11px 16px",
        textTransform: "uppercase",
        fontFamily: "'Oswald', Arial, sans-serif",
      }}
    >
      Letter of Representation
    </div>
  );

  const labelStyle = {
    display: "block",
    fontSize: 12,
    color: "#4b5563",
    marginBottom: 6,
    fontWeight: 400,
  };

  const fieldBoxStyle = {
    minHeight: 46,
    border: "1px solid #d1d5db",
    borderRadius: 12,
    padding: "10px 12px",
    background: "#fff",
    fontSize: 12,
    lineHeight: 1.35,
    color: "#111827",
    boxSizing: "border-box",
  };

  const bodyText = {
    fontSize: 14,
    lineHeight: 1.5,
    color: "#111827",
  };

  const footerBlock = (
    <div
      style={{
        borderTop: "3px solid #7c3aed",
        marginTop: 14,
        paddingTop: 10,
        fontSize: 12,
        color: "#111827",
        lineHeight: 1.35,
      }}
    >
      <div style={{ fontWeight: 700 }}>3600 Red Rd suite Ste 601B</div>
      <div>
        Miramar, FL 33025 • claims@capitalclaimgroup.com • +1 (954) 571-3035 •
        www.ccgclaims.com
      </div>
      <div style={{ marginTop: 6, fontWeight: 700, color: "#6d28d9" }}>
        License No: G240595
      </div>
    </div>
  );

  return (
    <div
      id="lor-printable-document"
      style={{
        background: "transparent",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        footer={<FooterImg />}
        contentPadding="0 0.42in 0.12in"
      >
        <LorTitleBar />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginTop: 10,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={labelStyle}>Date</div>
            <div style={fieldBoxStyle}>{data.date}</div>
          </div>

          <div>
            <div style={labelStyle}>Insurance Company</div>
            <div style={fieldBoxStyle}>{data.insuranceCompany}</div>
          </div>

          <div>
            <div style={labelStyle}>Address</div>
            <div style={fieldBoxStyle}>
              <div style={{ whiteSpace: "pre-line" }}>{fullAddress}</div>
            </div>
          </div>

          <div>
            <div style={labelStyle}>State</div>
            <div style={fieldBoxStyle}>{data.state}</div>
          </div>

          <div>
            <div style={labelStyle}>Claim #</div>
            <div style={fieldBoxStyle}>{data.claimNumber}</div>
          </div>

          <div>
            <div style={labelStyle}>Client / Insured</div>
            <div style={fieldBoxStyle}>
              {[data.homeowner1, data.homeowner2].filter(Boolean).join(", ")}
            </div>
          </div>

          <div>
            <div style={labelStyle}>Loss Location</div>
            <div style={fieldBoxStyle}>
              <div style={{ whiteSpace: "pre-line" }}>
                {displayedLossLocation}
              </div>
            </div>
          </div>

          <div>
            <div style={labelStyle}>Policy #</div>
            <div style={fieldBoxStyle}>{data.policyNumber}</div>
          </div>

          <div>
            <div style={labelStyle}>Date of Loss</div>
            <div style={fieldBoxStyle}>{data.dateOfLoss}</div>
          </div>

          <div>
            <div style={labelStyle}>Signer Email (recipient)</div>
            <div style={fieldBoxStyle}>{data.signerEmail}</div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid #d1d5db", marginBottom: 14 }} />

        <div style={bodyText}>
          <p style={{ margin: "0 0 10px" }}>Dear Claims Manager:</p>

          <p style={{ margin: "0 0 10px" }}>
            This correspondence will serve to inform you and the Insurance
            Company that your insured has formally retained our services to
            assist them in evaluating and presenting their above-referenced
            claim. We have enclosed a copy of our signed representation notice,
            which we request that you record in your claim file and properly
            provide us with a written acknowledgment of our involvement.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Additionally, we request that all further contact and communication
            involving this claim’s processing from the Insurance Company be
            directed exclusively through our offices. This also extends to your
            representative contractor/claims agents and/or any other claims
            agents you may be using in the processing of this claim.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Further, as the policy sets forth the duties, rights, and
            parameters of coverage, it is critical that we have expedited access
            to this information, we hereby request a true and complete certified
            copy of the applicable policy contract including the declarations
            page, all policy endorsements, and the original policy application.
            Please expedite these documents to our attention.
          </p>
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        footer={<FooterImg />}
        contentPadding="0 0.42in 0.12in"
      >
        <div style={{ ...bodyText, marginTop: 10 }}>
          <p style={{ margin: "0 0 14px", fontStyle: "italic" }}>
            Also, please note that Capital Claims Group Inc. should be named as
            an additional payee on all insurance drafts and/or payments,
            pursuant to the enclosed Notice of Loss/Notice of Representation
            signed by the Insured(s). The insured(s) hereby reserve all rights
            to make claims under the policy for replacement cost benefits as set
            forth in the policy and likewise invoke their rights to repair,
            rebuild or replace the damaged property.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Surely, you understand the Assured’s need to have this claim
            processed as quickly as possible, and as such, we will be
            undertaking all necessary steps to document and prepare their claim
            for submission. We look forward to working cooperatively with you to
            reach a fair and prompt resolution to this claim. Please feel free
            to contact us at 954-874-3563 to discuss the current status of this
            claim and to coordinate our efforts in the loss investigation and
            valuation process.
          </p>

          <p style={{ margin: "0 0 18px", fontStyle: "italic" }}>
            The Assureds hereby reserve all of their rights under the policy and
            the laws of this State and nothing contained herein is intended to
            waive or prejudice said rights.
          </p>

          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              marginBottom: 8,
            }}
          >
            Insured Signature
          </div>

          <div
            style={{
              border: "1px dashed #cbd5e1",
              borderRadius: 12,
              minHeight: 138,
              background: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              padding: 12,
            }}
          >
            {sig1 || sig2 ? (
              <div
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                  gap: 18,
                  alignItems: "center",
                }}
              >
                <div style={{ textAlign: "center" }}>
                  {sig1 ? (
                    <img
                      src={sig1}
                      alt="Insured Signature 1"
                      style={{
                        maxWidth: "100%",
                        maxHeight: 80,
                        objectFit: "contain",
                      }}
                    />
                  ) : (
                    <span style={{ color: "#94a3b8", fontSize: 12 }}>
                      Signature pending
                    </span>
                  )}
                </div>

                {hasSecond ? (
                  <div style={{ textAlign: "center" }}>
                    {sig2 ? (
                      <img
                        src={sig2}
                        alt="Insured Signature 2"
                        style={{
                          maxWidth: "100%",
                          maxHeight: 80,
                          objectFit: "contain",
                        }}
                      />
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: 12 }}>
                        Signature pending
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <span style={{ color: "#94a3b8", fontSize: 12 }}>
                Signature pending
              </span>
            )}
          </div>

          {footerBlock}
        </div>
      </PdfPage>

      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="Letter of Representation"
        claimId={claimId}
        isExportingPdf={isExportingPdf}
      />
    </div>
  );
}

function PublicAdjusterContract({
  data,
  sig1,
  sig2,
  auditInfo,
  claimId,
  isExportingPdf = false,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const insuredNames = [data.homeowner1, data.homeowner2]
    .filter(Boolean)
    .join(", ");

  const bodyText = {
    fontSize: 14,
    lineHeight: 1.43,
    color: "#111827",
    fontFamily: "Arial, Helvetica, sans-serif",
  };

  const sectionHead = {
    color: "#199c2e",
    fontWeight: 700,
    textTransform: "uppercase",
  };

  const HeaderImg = () => (
    <img
      src={PA_ASSETS.header}
      alt="header"
      style={{ width: "100%", display: "block" }}
    />
  );

  const FooterImg = () => (
    <img
      src={PA_ASSETS.footer}
      alt="footer"
      style={{ width: "100%", display: "block" }}
    />
  );

  const TitleBarImg = () => (
    <div
      style={{
        width: "100%",
        display: "block",
        margin: "10px 0 12px",
        background: "#199c2e",
        color: "#fff",
        textAlign: "center",
        fontWeight: 700,
        fontSize: 20,
        letterSpacing: 1,
        padding: "11px 16px",
        textTransform: "uppercase",
        fontFamily: "'Oswald', Arial, sans-serif",
        boxSizing: "border-box",
      }}
    >
      Public Adjuster Contract
    </div>
  );

  const InitialsRow = () => (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 24,
        marginTop: 12,
        paddingTop: 8,
        borderTop: "1px solid #e5e7eb",
        flexWrap: "wrap",
      }}
    >
      {/* PA Initials — Benito Paul "BP" in Brush Script */}
      <div style={{ minWidth: 80 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>PA Initials:</div>
        <div
          style={{
            borderBottom: "1px solid #199c2e",
            height: 26,
            display: "flex",
            alignItems: "flex-end",
            paddingBottom: 2,
          }}
        >
          <span
            style={{
              fontFamily: '"Brush Script MT", cursive',
              fontSize: 20,
              color: "#111827",
              lineHeight: 1,
            }}
          >
            BP
          </span>
        </div>
      </div>

      {/* Homeowner 1 initials */}
      <div style={{ minWidth: 80 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
          {data.homeowner1 ? `${data.homeowner1} Initials:` : "Homeowner Initials:"}
        </div>
        <div
          style={{
            borderBottom: "1px solid #000",
            height: 26,
            display: "flex",
            alignItems: "flex-end",
            paddingBottom: 2,
          }}
        >
          {data.initials1 ? (
            <img src={data.initials1} alt="initials 1" style={{ height: 20 }} />
          ) : (
            <span style={{ fontSize: 13, color: "#9ca3af" }}>__</span>
          )}
        </div>
      </div>

      {/* Homeowner 2 initials — only if second homeowner */}
      {hasSecond ? (
        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
            {data.homeowner2 ? `${data.homeowner2} Initials:` : "Homeowner 2 Initials:"}
          </div>
          <div
            style={{
              borderBottom: "1px solid #000",
              height: 26,
              display: "flex",
              alignItems: "flex-end",
              paddingBottom: 2,
            }}
          >
            {data.initials2 ? (
              <img src={data.initials2} alt="initials 2" style={{ height: 20 }} />
            ) : (
              <span style={{ fontSize: 13, color: "#9ca3af" }}>__</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );

  const Footer = ({ page }) => (
    <div>
      {isExportingPdf ? (
        <div
          style={{
            textAlign: "center",
            fontSize: 12,
            color: "#2f9e44",
            fontStyle: "italic",
            marginBottom: 4,
            lineHeight: 1.2,
          }}
        >
          Page {page} of 4
        </div>
      ) : null}
      <FooterImg />
    </div>
  );

  const topGrid = (
    <div
      style={{
        ...bodyText,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        columnGap: 36,
        rowGap: 10,
        marginTop: 10,
        marginBottom: 4,
      }}
    >
      <div>
        <strong>Insured:</strong> {insuredNames}
      </div>
      <div>
        <strong>Loss Description:</strong> {data.lossDescription}
      </div>

      <div>
        <strong>Phone:</strong> {data.phone}
      </div>
      <div>
        <strong>Claim Type:</strong> {data.claimType}
      </div>

      <div>
        <strong>Email:</strong> {data.signerEmail}
      </div>
      <div>
        <strong>Situation:</strong> {data.situation}
      </div>

      <div>
        <strong>Insurer:</strong> {data.insuranceCompany}
      </div>
      <div>
        <strong>Date of Loss:</strong> {data.dateOfLoss}
      </div>

      <div>
        <strong>Policy #:</strong> {data.policyNumber}
      </div>
      <div>
        <strong>Claim #:</strong> {data.claimNumber}
      </div>

      <div style={{ gridColumn: "1 / -1" }}>
        <strong>Address:</strong>{" "}
        {[data.address, data.city, data.state, data.zip]
          .filter(Boolean)
          .join(", ")}
      </div>
    </div>
  );

  return (
    <div id="pac-printable-document" style={{ background: "transparent" }}>
      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={1} />}
      >
        {topGrid}
        <TitleBarImg />

        <div style={bodyText}>
          <p style={{ margin: "0 0 6px" }}>
            1. <span style={sectionHead}>Service Fee:</span>
          </p>
          <p style={{ margin: "0 0 6px" }}>
            The insured(s) hereby retains Capital Claims Group to be its public
            adjuster and hereby appoints Capital Claims Group to be its
            independent appraiser to appraise, advise, negotiate, and/or settle
            the above-referenced claim.
          </p>
          <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            The insured(s) agrees to pay and hereby assigns to Capital Claims Group <strong>10%</strong> of all payments made by the insurance company related to this claim.
          </p>
          <p style={{ margin: "0 0 10px" }}>
            In the event appraisal, mediation is demanded, or a lawsuit ensues regarding the
            above-mentioned claim, there will be an additional charge of five
            percent. The total contractual percentage shall not exceed the
            maximum allowed by law.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            2. <span style={sectionHead}>Additional Payee:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured authorizes and requests the insurer and the insured’s
            mortgage carrier to have Capital Claims Group appear as an
            additional payee on all checks issued regarding the above-mentioned
            claim. The insured hereby grants Capital Claims Group a lien on
            recovered proceeds received by the insurer to the extent of the fee
            due to Capital Claims Group pursuant to this agreement.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            3. <span style={sectionHead}>Third-Party Fees:</span>
          </p>
          <p style={{ margin: 0 }}>
            The insured understands it may be necessary to incur professional
            fees on the insured’s behalf to properly adjust the claim. These
            fees may include, but are not limited to, a General Contractor,
            Engineer, Claim Appraiser, Plumber, Roofer, and Environmental
            Hygienist. The insured understands that no professional fees will be
            incurred without the insured’s written or verbal authorization, and
            that the insured may then be responsible for such fees.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={2} />}
      >
        <div style={bodyText}>
          <p style={{ margin: "0 0 6px" }}>
            4. <span style={sectionHead}>Endorsement:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured’s endorsement on any insurance proceeds check will be
            deemed to be an agreement with the terms and conditions of any
            related settlement regarding the above-mentioned claim.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            5. <span style={sectionHead}>Affidavit:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            I,{" "}
            <span
              style={{
                display: "inline-block",
                minWidth: 250,
                borderBottom: "1px solid #111827",
                fontWeight: 600,
              }}
            >
              {insuredNames || "____________________________"}
            </span>
            , a named insured under the above-mentioned policy, hereby swear and
            attest that I have the authority to enter into this contract and
            settle all claims issued on behalf of all named insureds. Insured
            acknowledges, understands, and agrees that under section 626.8796,
            Florida Statutes, an agreement with a public adjuster must be signed
            by all named insureds.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            6. <span style={sectionHead}>Legal:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            Capital Claims Group is not a law firm and does not offer legal
            advice, and there will be no attorney-client relationship with the
            insured(s). The insured is hereby advised of the right to counsel
            and may consult with an attorney regarding their claim independently
            of Capital Claims Group.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            7. <span style={sectionHead}>Letter of Protection:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured understands and agrees that if it becomes necessary to
            retain an attorney, the insured authorizes and agrees to a Letter of
            Protection for Capital Claims Group.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            8. <span style={sectionHead}>Representation:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured hereby affirms that no other claim(s) have been filed in
            reference to the same peril and that no other legal representation
            is involved with the claim other than:
          </p>

          <div
            style={{
              borderBottom: "1px solid #111827",
              width: 320,
              marginBottom: 12,
              minHeight: 18,
              fontWeight: 600,
            }}
          >
            Capital Claims Group
          </div>

          <p style={{ margin: "0 0 6px" }}>
            9. <span style={sectionHead}>Severability:</span>
          </p>
          <p style={{ margin: 0 }}>
            Unenforceability or invalidity of one or more clauses in this
            Agreement shall not affect any other clause.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            10. <span style={sectionHead}>Dispute:</span>
          </p>
          <p style={{ margin: "0 0 12px" }}>
            In the event of litigation arising from this agreement, the venue
            shall be in Miami-Dade County, Florida. The prevailing party shall
            be entitled to recover its court costs, reasonable attorney fees,
            including those incurred during any appeal proceedings, and interest
            on any past due fees at the maximum rate permitted by applicable
            law.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            11.{" "}
            <span style={sectionHead}>Commercial Policy Cancellation:</span>
          </p>
          <p style={{ margin: "0 0 12px" }}>
            You, the insured(s), may cancel this contract for any reason without
            penalty or obligation to you within 10 days after the date of this
            contract.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={3} />}
      >
        <div style={bodyText}>
          <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 18, lineHeight: 1.4 }}>
            12.{" "}
            <span style={{ color: "#199c2e" }}>
              Residential Policy Cancellation:
            </span>
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            You, the insured, may cancel this contract for any reason without
            penalty or obligation to you within 10 days after the date of this
            contract.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            If this contract was entered into based on events that are the
            subject of a declaration of a state of emergency by the Governor,
            you may cancel this contract for any reason without penalty or
            obligation to you within 30 days after the date of loss or 10 days
            after the date on which the contract is executed, whichever is
            longer. You may also cancel this contract without penalty or
            obligation to you if I, as your public adjuster, fail to provide you
            and your insurer a copy of a written estimate within 60 days of the
            execution of the contract, unless the failure to provide the
            estimate within 60 days is caused by factors beyond my control.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            The notice of cancellation shall be provided to Capital Claims
            Group, submitted in writing, and sent by certified mail, return
            receipt requested, or another form of mailing that provides proof
            thereof, at the address specified in the contract.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            Pursuant to s. 817.234, Florida Statutes, any person who, with the
            intent to injure, defraud, or deceive any insurer or insured,
            prepares, presents, or causes to be presented a proof of loss or
            estimate of cost or repair of damaged property in support of a claim
            under an insurance policy, knowing that the proof of loss or
            estimate of claim or repairs contains any false, incomplete, or
            misleading information concerning any fact or thing material to the
            claim, commits a felony of the third degree, punishable as provided
            in s. 775.082, s. 775.803, or s. 775.084, Florida Statutes.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            Insured(s) have read, understand and voluntarily sign the foregoing
            Agreement. A computer or faxed signature or copy of this document
            shall be deemed to have the same effect as the original.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={4} />}
      >
        <div style={bodyText}>

          <div
            style={{
              borderTop: "4px solid #199c2e",
              marginTop: 18,
              marginBottom: 14,
            }}
          />

          <div
            style={{
              color: "#199c2e",
              fontWeight: 700,
              fontSize: 14,
              marginBottom: 14,
            }}
          >
            CAPITAL CLAIMS GROUP
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
              gap: 24,
              alignItems: "start",
            }}
          >
            <div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 1fr",
                  rowGap: 8,
                  columnGap: 8,
                  fontSize: 12,
                }}
              >
                <div>By:</div>
                <div style={{ background: "#d7c2f0", padding: "4px 8px" }}>
                  {PA_FIXED.name}
                </div>

                <div>License:</div>
                <div
                  style={{
                    background: "#d7c2f0",
                    padding: "4px 8px",
                    fontWeight: 700,
                  }}
                >
                  {PA_FIXED.license}
                </div>

                <div>Signature:</div>
                <div style={{ background: "#d7c2f0", padding: "4px 8px" }}>
                  <img
                    src={PA_FIXED.signatureImage}
                    alt="Benito Paul signature"
                    style={{ height: 22, objectFit: "contain" }}
                  />
                </div>

                <div>Date:</div>
                <div>{data.date}</div>
              </div>
            </div>

            <div>
              <div style={{ marginBottom: 10, fontSize: 12 }}>
                <div>Insured (Print): {data.homeowner1}</div>
                <div style={{ marginTop: 8, minHeight: 36 }}>
                  {sig1 ? (
                    <img
                      src={sig1}
                      alt="Insured signature 1"
                      style={{ height: 30, objectFit: "contain" }}
                    />
                  ) : null}
                </div>
                <div style={{ fontSize: 12 }}>
                  Signature of the policyholder
                </div>
                <div style={{ marginTop: 8 }}>Date: {data.date}</div>
              </div>

              {hasSecond ? (
                <div style={{ marginTop: 18, fontSize: 12 }}>
                  <div>Insured (Print): {data.homeowner2}</div>
                  <div style={{ marginTop: 8, minHeight: 36 }}>
                    {sig2 ? (
                      <img
                        src={sig2}
                        alt="Insured signature 2"
                        style={{ height: 30, objectFit: "contain" }}
                      />
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    Signature of the policyholder
                  </div>
                  <div style={{ marginTop: 8 }}>Date: {data.date}</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </PdfPage>

      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="PA Authorization"
        claimId={claimId}
        isExportingPdf={isExportingPdf}
      />
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("input");
  const [selectedDocs, setSelectedDocs] = useState(["insp", "lor", "pac"]);
  const [signMode, setSignMode] = useState("now");
  const [data, setData] = useState(initialData);
  const [pendingSend, setPendingSend] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Inspection form state ──
  const initialInspData = {
    date: new Date().toISOString().split("T")[0],
    clientName: "",
    mobile: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    email: "",
  };
  const [inspData, setInspData] = useState(initialInspData);
  const [inspSig, setInspSig] = useState("");
  const [inspSigMethod, setInspSigMethod] = useState("draw");
  const [inspTypedSig, setInspTypedSig] = useState("");
  const [inspSigFont, setInspSigFont] = useState(SIGNATURE_FONTS[0]);
  const [inspSubmitting, setInspSubmitting] = useState(false);
  const [inspectionOnly, setInspectionOnly] = useState(false);
  const [duplicateRecord, setDuplicateRecord] = useState(null);
  const [inspSubmitAttempted, setInspSubmitAttempted] = useState(false);

  const updateInsp = (key, val) => setInspData(prev => ({ ...prev, [key]: val }));

  const effectiveInspSig = inspSigMethod === "type"
    ? (inspTypedSig ? typedSignatureToDataUrl(inspTypedSig, inspSigFont) : "")
    : inspSig;
  const [teamMembers, setTeamMembers] = useState([]);
  const [currentClaimId, setCurrentClaimId] = useState(null);
  const [isSigningFromLink, setIsSigningFromLink] = useState(false);
  const [isLoadingSigningLink, setIsLoadingSigningLink] = useState(false);
  const [auditInfo, setAuditInfo] = useState(initialAuditInfo);

  // Manager-editable content — persisted to localStorage
  const DEFAULTS = {
    reviewHeadline: "We're fighting for you — just two quick steps and we can get your claim moving. It's fast, easy, and completely secure.",
    reviewLorText: "This simply lets your insurance company know that Capital Claims Group is in your corner, handling all the back-and-forth on your behalf. You won't have to deal with them directly at all.",
    reviewPacText: "This is our working agreement — it outlines how we get paid (only when you get paid) and confirms that we're fully committed to maximizing your claim. No upfront costs, ever.",
    reviewHelpText: "You can tap 'Preview' to read any document first. When you're ready, hit 'Looks Good!' on each one and scroll down to sign.",
    thankYouHeadline: "You're All Set — Let's Get Your Money! 🚀",
    thankYouOpening: "You did it! Your documents are signed and we're officially on the case. Here's exactly what happens next:",
    thankYouSteps: JSON.stringify([
      "📞 Your public adjuster will call you within 24 hours to introduce themselves and answer any questions.",
      "🏠 We'll schedule a property inspection to document every bit of damage — the insurance company won't miss a thing.",
      "📋 We build your full claim package and submit it to the insurance company on your behalf.",
      "💰 We negotiate hard to maximize your settlement — you don't pay us unless you get paid.",
      "🎉 You receive your settlement and we handle all the paperwork. Sit back and let us do the work!",
    ]),
    thankYouClosing: "We're so glad you chose Capital Claims Group. You made the right call. Talk soon! 💚",
    preInspHeadline: "Inspection Booked — We're On It! 🏠",
    preInspOpening: "You're all signed up! Your free roof inspection is next. Here's what to expect:",
    preInspSteps: JSON.stringify([
      "📅 Your rep will schedule your free roof inspection — usually within 1–3 business days.",
      "🏠 One of our trained inspectors will visit the property and document any damage thoroughly.",
      "📊 We review the inspection report and advise you on whether to file a claim.",
      "✅ If damage is found, we'll have you sign the PA paperwork and get to work immediately.",
      "💚 No damage found? No problem — the inspection is completely free, no strings attached.",
    ]),
    preInspClosing: "We'll be in touch soon to schedule your inspection. Thank you for trusting Capital Claims Group! 💚",
    inspOnlyHeadline: "Inspection Booked — We'll Be In Touch! 🏠",
    inspOnlyOpening: "Thank you for signing your Free Roof Inspection Agreement with U.S. Shingle & Metal LLC. Your inspector will be in touch shortly to schedule a visit.",
    inspOnlySteps: JSON.stringify([
      "📞 Your sales rep will contact you within 24 hours to schedule the inspection.",
      "🏠 A licensed inspector will visit your property and document any roof damage.",
      "📊 All findings and photos are forwarded to a licensed Public Adjuster for review.",
      "✅ If storm damage is confirmed, you'll be contacted about your options for filing a claim.",
      "💚 No damage found? No problem — the inspection is completely free with no obligation.",
    ]),
    inspOnlyClosing: "Thank you for trusting U.S. Shingle & Metal LLC. We'll be in touch soon! 🏠",
    ussWelcomeHeading: "What Happens Next",
    ussWelcomeSteps: JSON.stringify([
      "Your sales representative will contact you within 24 hours to coordinate the inspection.",
      "One of our trained inspectors will visit your property and thoroughly document any storm damage.",
      "All findings and photos are forwarded to a licensed Public Adjuster for professional review.",
      "If storm damage is confirmed, you will be contacted about your options for filing an insurance claim.",
      "If no damage is found — no problem! The inspection is completely free with no obligation.",
    ]),
    ussContactPhone: "727.761.5200",
    ussContactEmail: "info@shingleusa.com",
    activityEmail: "",
    managerPin: "1234",
  };

  const loadSetting = (key) => {
    try { return localStorage.getItem("ccg_mgr_" + key) || DEFAULTS[key]; } catch { return DEFAULTS[key]; }
  };
  const saveSetting = (key, value) => {
    try { localStorage.setItem("ccg_mgr_" + key, value); } catch {}
  };

  const [reviewHeadline, setReviewHeadlineRaw] = useState(() => loadSetting("reviewHeadline"));
  const [reviewLorText, setReviewLorTextRaw] = useState(() => loadSetting("reviewLorText"));
  const [reviewPacText, setReviewPacTextRaw] = useState(() => loadSetting("reviewPacText"));
  const [reviewHelpText, setReviewHelpTextRaw] = useState(() => loadSetting("reviewHelpText"));
  const [thankYouHeadline, setThankYouHeadlineRaw] = useState(() => loadSetting("thankYouHeadline"));
  const [thankYouOpening, setThankYouOpeningRaw] = useState(() => loadSetting("thankYouOpening"));
  const [thankYouSteps, setThankYouStepsRaw] = useState(() => {
    try { return JSON.parse(loadSetting("thankYouSteps")); } catch { return JSON.parse(DEFAULTS.thankYouSteps); }
  });
  const [thankYouClosing, setThankYouClosingRaw] = useState(() => loadSetting("thankYouClosing"));
  const [managerPin, setManagerPinRaw] = useState(() => loadSetting("managerPin"));
  const [managerPinEntry, setManagerPinEntry] = useState("");
  const [managerUnlocked, setManagerUnlocked] = useState(false);
  const [managerTYTab, setManagerTYTab] = useState("post_inspection");
  const [managerSection, setManagerSection] = useState("home");
  const [reportData, setReportData] = useState(null);

  // Sales rep manager

  // Sales rep manager
  const [reps, setReps] = useState([]);
  const [repsLoaded, setRepsLoaded] = useState(false);
  const [newRepName, setNewRepName] = useState("");
  const [newRepEmail, setNewRepEmail] = useState("");
  const [newRepJnId, setNewRepJnId] = useState("");
  const [repSaving, setRepSaving] = useState(false);
  const [jnUsers, setJnUsers] = useState([]);
  const [jnImporting, setJnImporting] = useState(false);
  const [jnImportError, setJnImportError] = useState("");

  const fetchJnUsers = async () => {
    setJnImporting(true);
    setJnImportError("");
    try {
      const res = await fetch("/.netlify/functions/jobnimbus-users");
      const data = await res.json();
      if (data.members && data.members.length > 0) {
        setJnUsers(data.members);
      } else {
        setJnImportError("No users returned from JN. Check API connection.");
      }
    } catch (e) {
      setJnImportError("Failed to connect to JN API.");
    } finally {
      setJnImporting(false);
    }
  };

  const lookupJnUser = async (repId, repName) => {
    // Try to find matching JN user by name similarity
    if (!jnUsers.length) return null;
    const nameLower = repName.toLowerCase();
    const parts = nameLower.split(" ");
    return jnUsers.find(u => {
      const jnName = u.name.toLowerCase();
      return jnName === nameLower ||
        (parts.length >= 2 && jnName.includes(parts[0]) && jnName.includes(parts[parts.length - 1]));
    }) || null;
  };

  const syncRepFromJn = async (repId, repName) => {
    const match = await lookupJnUser(repId, repName);
    if (!match) {
      alert(`Could not find "${repName}" in Job Nimbus. Check that the name matches exactly.`);
      return;
    }
    const { error } = await supabase.from("sales_reps")
      .update({ jobnimbus_id: match.jobnimbus_id })
      .eq("id", repId);
    if (!error) {
      await loadReps();
      alert(`✅ Linked "${repName}" → JN ID: ${match.jobnimbus_id}`);
    }
  };

  const importAllFromJn = async () => {
    if (!jnUsers.length) { alert("Load JN users first."); return; }
    let added = 0;
    for (const u of jnUsers) {
      if (!u.name || u.name.toLowerCase().includes("test")) continue;
      const exists = reps.find(r => r.name.toLowerCase() === u.name.toLowerCase());
      if (!exists) {
        await supabase.from("sales_reps").insert([{
          name: u.name,
          jobnimbus_id: u.jobnimbus_id,
          email: u.email || "",
        }]);
        added++;
      } else if (u.jobnimbus_id) {
        const updates = { jobnimbus_id: u.jobnimbus_id };
        if (u.email && !exists.email) updates.email = u.email;
        await supabase.from("sales_reps").update(updates).eq("id", exists.id);
      }
    }
    await loadReps();
    alert(`✅ Import complete — ${added} new rep(s) added.`);
  };

  const loadReps = async () => {
    const { data, error } = await supabase.from("sales_reps").select("*").order("name");
    if (!error) { setReps(data || []); setRepsLoaded(true); }
    else console.error("loadReps error:", error);
  };

  const seedRepsFromList = async () => {
    const knownReps = [
      { name: 'Anthony "Brent" Parker', jobnimbus_id: "54ef6f4d65ec46f083d2d8abf678c2fc" },
      { name: "Brandon Latronica",      jobnimbus_id: "22c5d7fc66a54ce98e6a84baf7d242f4" },
      { name: "Bruce Holbert",          jobnimbus_id: "2f48ee33e65f49bb93018f55dd2992e3" },
      { name: "Bruce Lowther",          jobnimbus_id: "e5a7561db36e43e0aa4c7f254b291165" },
      { name: "Byron Ulrich",           jobnimbus_id: "mjbyrlmh4k077ynqcnt97a6" },
      { name: "Chris Baughan",          jobnimbus_id: "95bf148916f141acad5d9df5e7aba0d0" },
      { name: "Chris Gourdine",         jobnimbus_id: "mbtud30ydxwyiwsljut9ue6" },
      { name: "Chris Hill",             jobnimbus_id: "31e0d80686714125ab0e08eefd13f8a7" },
      { name: "Christopher Rath",       jobnimbus_id: "mjaf8gndd3am0tpi2jrgbt1" },
      { name: "Corrie Dennie",          jobnimbus_id: "mbjvh9ev82npk3wh91tkm5k" },
      { name: "Corynn Colbert",         jobnimbus_id: "mjheo3un8v3xbk0etrk101x" },
      { name: "David Kirkbribe",        jobnimbus_id: "mjiuedq3au9cjffclui1g30" },
      { name: "Eric Kofler",            jobnimbus_id: "mjiufcezufnrdze6h414e3m" },
      { name: "Heath Larner",           jobnimbus_id: "715ff737aa334af29eefd5014c9bc519" },
      { name: "Jason Hunt",             jobnimbus_id: "cbf9e3ab0f564d269bce24efdc48e7d6" },
      { name: "Jermie James",           jobnimbus_id: "mjiuednf61am6t4td796xef" },
      { name: "Jerry Rooney",           jobnimbus_id: "mjomom1c1v3jod1z97il1z6" },
      { name: "John King",              jobnimbus_id: "496e19b644c0459cab64144378357f16" },
      { name: "Jose Huerta",            jobnimbus_id: "e66f617fb6cb4e829ca87592b454a44d" },
      { name: "Joseph LeBlanc",         jobnimbus_id: "1fde2aa1681d49be8ea15d7f498c2535" },
      { name: "Justin Jones",           jobnimbus_id: "mjbyrnzv1sn3fu3chh26m98" },
      { name: "Michael Brown",          jobnimbus_id: "40f8a3d05be14548906510da185a55d5" },
      { name: "William Hernandez",      jobnimbus_id: "m9k7jgp9j6t5ncdvy8w5it6" },
      { name: "Yulia Karnitskaya",      jobnimbus_id: "21a6d8b32e4442ffb50b9d911266c89f" },
    ];
    setRepSaving(true);
    let added = 0, updated = 0;
    for (const rep of knownReps) {
      const existing = reps.find(r => r.name.toLowerCase() === rep.name.toLowerCase());
      if (!existing) {
        await supabase.from("sales_reps").insert([rep]);
        added++;
      } else if (!existing.jobnimbus_id) {
        await supabase.from("sales_reps").update({ jobnimbus_id: rep.jobnimbus_id }).eq("id", existing.id);
        updated++;
      }
    }
    await loadReps();
    setRepSaving(false);
    alert(`✅ Done — ${added} added, ${updated} updated.`);
  };

  const saveRep = async () => {
    if (!newRepName.trim()) return;
    setRepSaving(true);
    const { error } = await supabase.from("sales_reps").insert([{
      name: newRepName.trim(),
      email: newRepEmail.trim(),
      jobnimbus_id: newRepJnId.trim(),
    }]);
    if (!error) {
      setNewRepName(""); setNewRepEmail(""); setNewRepJnId("");
      await loadReps();
    }
    setRepSaving(false);
  };

  const deleteRep = async (id) => {
    await supabase.from("sales_reps").delete().eq("id", id);
    await loadReps();
  };

  const toggleRepActive = async (id, currentActive) => {
    await supabase.from("sales_reps").update({ active: !currentActive }).eq("id", id);
    await loadReps();
  };

  const [showInactiveReps, setShowInactiveReps] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const [reportStartDate, setReportStartDate] = useState(weekAgo);
  const [reportEndDate, setReportEndDate] = useState(today);

  const fetchReport = async (startDate, endDate) => {
    setReportLoading(true);
    setReportData(null);
    try {
      const start = startDate + "T00:00:00.000Z";
      const end = endDate + "T23:59:59.999Z";

      const [claimsRes, inspRes] = await Promise.allSettled([
        supabase.from("claims")
          .select("id, homeowner1, homeowner2, address, city, state, signed_at, sign_method, representative_name_old, sales_rep_name, sales_rep_email, docs_signed")
          .gte("signed_at", start)
          .lte("signed_at", end)
          .order("signed_at", { ascending: false }),
        supabase.from("inspections")
          .select("id, client_name, address, city, state, signed_at, sales_rep_name, sales_rep_email")
          .gte("signed_at", start)
          .lte("signed_at", end)
          .order("signed_at", { ascending: false }),
      ]);

      const claims = claimsRes.status === "fulfilled" ? (claimsRes.value.data || []) : [];
      const inspections = inspRes.status === "fulfilled" ? (inspRes.value.data || []) : [];

      const claimsError = claimsRes.value?.error?.message || (claimsRes.status === "rejected" ? claimsRes.reason : null);
      const inspError = inspRes.value?.error?.message || (inspRes.status === "rejected" ? inspRes.reason : null);

      console.log("Report range:", start, "to", end);
      console.log("Claims:", claims.length, "error:", claimsError);
      console.log("Inspections:", inspections.length, "error:", inspError);

      const allSignings = [
        ...claims.map(c => {
          const docs = (c.docs_signed || "").split(",").filter(Boolean);
          // If docs_signed not stored, infer from claim existing = lor+pac
          const hasInsp = docs.includes("insp") || docs.length === 0 ? docs.includes("insp") : false;
          const hasLor = docs.includes("lor") || docs.length === 0;
          const hasPac = docs.includes("pac") || docs.length === 0;
          return {
            type: "claim",
            name: [c.homeowner1, c.homeowner2].filter(Boolean).join(" & ") || "—",
            address: [c.address, c.city, c.state].filter(Boolean).join(", "),
            signedAt: c.signed_at,
            signMethod: c.sign_method,
            rep: c.sales_rep_name || c.representative_name_old || "Unassigned",
            hasInsp,
            hasLor,
            hasPac,
          };
        }),
        ...inspections.map(i => ({
          type: "insp",
          name: i.client_name || "—",
          address: [i.address, i.city, i.state].filter(Boolean).join(", "),
          signedAt: i.signed_at,
          signMethod: "sign_now",
          rep: i.sales_rep_name || "Unassigned",
          hasInsp: true,
          hasLor: false,
          hasPac: false,
        })),
      ];

      const byRep = {};
      allSignings.forEach(s => {
        const key = s.rep || "Unassigned";
        if (!byRep[key]) byRep[key] = [];
        byRep[key].push(s);
      });
      Object.values(byRep).forEach(arr => arr.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt)));

      setReportData({
        byRep,
        totalClaims: claims.length,
        totalInspections: inspections.length,
        startDate, endDate,
        claimsError,
        inspError,
      });
    } catch (e) {
      console.error("Report fetch error:", e);
    } finally {
      setReportLoading(false);
    }
  };

  // Wrappers that save to localStorage on every change
  const setReviewHeadline = (v) => { setReviewHeadlineRaw(v); saveSetting("reviewHeadline", v); };
  const setReviewLorText  = (v) => { setReviewLorTextRaw(v);  saveSetting("reviewLorText", v); };
  const setReviewPacText  = (v) => { setReviewPacTextRaw(v);  saveSetting("reviewPacText", v); };
  const setReviewHelpText = (v) => { setReviewHelpTextRaw(v); saveSetting("reviewHelpText", v); };
  const setThankYouHeadline = (v) => { setThankYouHeadlineRaw(v); saveSetting("thankYouHeadline", v); };
  const setThankYouOpening = (v) => { setThankYouOpeningRaw(v); saveSetting("thankYouOpening", v); };
  const setThankYouSteps   = (v) => { setThankYouStepsRaw(v);   saveSetting("thankYouSteps", JSON.stringify(v)); };
  const setThankYouClosing = (v) => { setThankYouClosingRaw(v); saveSetting("thankYouClosing", v); };
  const setManagerPin     = (v) => { setManagerPinRaw(v);     saveSetting("managerPin", v); };

  // Pre-inspection flow state
  const [preInspHeadline, setPreInspHeadlineRaw] = useState(() => loadSetting("preInspHeadline"));
  const [preInspOpening,  setPreInspOpeningRaw]  = useState(() => loadSetting("preInspOpening"));
  const [preInspSteps,    setPreInspStepsRaw]    = useState(() => {
    try { return JSON.parse(loadSetting("preInspSteps")); } catch { return JSON.parse(DEFAULTS.preInspSteps); }
  });
  const [preInspClosing,  setPreInspClosingRaw]  = useState(() => loadSetting("preInspClosing"));
  const setPreInspHeadline = (v) => { setPreInspHeadlineRaw(v); saveSetting("preInspHeadline", v); };

  // Inspection-only flow state
  const [inspOnlyHeadline, setInspOnlyHeadlineRaw] = useState(() => loadSetting("inspOnlyHeadline"));
  const [inspOnlyOpening,  setInspOnlyOpeningRaw]  = useState(() => loadSetting("inspOnlyOpening"));
  const [inspOnlySteps,    setInspOnlyStepsRaw]    = useState(() => {
    try { return JSON.parse(loadSetting("inspOnlySteps")); } catch { return JSON.parse(DEFAULTS.inspOnlySteps); }
  });
  const [inspOnlyClosing,  setInspOnlyClosingRaw]  = useState(() => loadSetting("inspOnlyClosing"));
  const setInspOnlyHeadline = (v) => { setInspOnlyHeadlineRaw(v); saveSetting("inspOnlyHeadline", v); };
  const setInspOnlyOpening  = (v) => { setInspOnlyOpeningRaw(v);  saveSetting("inspOnlyOpening", v); };
  const setInspOnlySteps    = (v) => { setInspOnlyStepsRaw(v);    saveSetting("inspOnlySteps", JSON.stringify(v)); };
  const setInspOnlyClosing  = (v) => { setInspOnlyClosingRaw(v);  saveSetting("inspOnlyClosing", v); };

  // USS Welcome PDF editable content
  const [ussWelcomeHeading, setUssWelcomeHeadingRaw] = useState(() => loadSetting("ussWelcomeHeading"));
  const [ussWelcomeSteps,   setUssWelcomeStepsRaw]   = useState(() => {
    try { return JSON.parse(loadSetting("ussWelcomeSteps")); } catch { return JSON.parse(DEFAULTS.ussWelcomeSteps); }
  });
  const [ussContactPhone,   setUssContactPhoneRaw]   = useState(() => loadSetting("ussContactPhone"));
  const [ussContactEmail,   setUssContactEmailRaw]   = useState(() => loadSetting("ussContactEmail"));
  const setUssWelcomeHeading = (v) => { setUssWelcomeHeadingRaw(v); saveSetting("ussWelcomeHeading", v); };
  const setUssWelcomeSteps   = (v) => { setUssWelcomeStepsRaw(v);   saveSetting("ussWelcomeSteps", JSON.stringify(v)); };
  const setUssContactPhone   = (v) => { setUssContactPhoneRaw(v);   saveSetting("ussContactPhone", v); };
  const setUssContactEmail   = (v) => { setUssContactEmailRaw(v);   saveSetting("ussContactEmail", v); };

  const [activityEmail, setActivityEmailRaw] = useState(() => loadSetting("activityEmail"));
  const setActivityEmail = (v) => { setActivityEmailRaw(v); saveSetting("activityEmail", v); };
  const setPreInspOpening  = (v) => { setPreInspOpeningRaw(v);  saveSetting("preInspOpening", v); };
  const setPreInspSteps    = (v) => { setPreInspStepsRaw(v);    saveSetting("preInspSteps", JSON.stringify(v)); };
  const setPreInspClosing  = (v) => { setPreInspClosingRaw(v);  saveSetting("preInspClosing", v); };

  // Derived: which thank you content to show
  // inspectionOnly = only inspection was signed (no PA forms)
  const activeTYHeadline = inspectionOnly ? inspOnlyHeadline
    : data.claimStage === "pre_inspection" ? preInspHeadline : thankYouHeadline;
  const activeTYOpening  = inspectionOnly ? inspOnlyOpening
    : data.claimStage === "pre_inspection" ? preInspOpening  : thankYouOpening;
  const activeTYSteps    = inspectionOnly ? inspOnlySteps
    : data.claimStage === "pre_inspection" ? preInspSteps    : thankYouSteps;
  const activeTYClosing  = inspectionOnly ? inspOnlyClosing
    : data.claimStage === "pre_inspection" ? preInspClosing  : thankYouClosing;

  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");
  const [typedSig1, setTypedSig1] = useState("");
  const [typedSig2, setTypedSig2] = useState("");
  const [sigMethod1, setSigMethod1] = useState("draw");
  const [sigMethod2, setSigMethod2] = useState("draw");
  const [sigFont1, setSigFont1] = useState(SIGNATURE_FONTS[0]);
  const [sigFont2, setSigFont2] = useState(SIGNATURE_FONTS[0]);

  const [initials1Typed, setInitials1Typed] = useState("");
  const [initials2Typed, setInitials2Typed] = useState("");
  const [initialsMethod1, setInitialsMethod1] = useState("draw");
  const [initialsMethod2, setInitialsMethod2] = useState("draw");
  const [initialsFont1, setInitialsFont1] = useState(SIGNATURE_FONTS[0]);
  const [initialsFont2, setInitialsFont2] = useState(SIGNATURE_FONTS[0]);

  const [lorAgreed, setLorAgreed] = useState(false);
  const [pacAgreed, setPacAgreed] = useState(false);
  const [inspAgreed, setInspAgreed] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const hasSecond = Boolean(data.homeowner2?.trim());

  const propertyAddressText = [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  const reviewReady =
    (!selectedDocs.includes("insp") || inspAgreed) &&
    (!selectedDocs.includes("lor") || lorAgreed) &&
    (!selectedDocs.includes("pac") || pacAgreed);

  useEffect(() => {
    if (data.lossLocationSameAsAddress) {
      setData((prev) => ({ ...prev, lossLocation: propertyAddressText }));
    }
  }, [
    data.address,
    data.city,
    data.state,
    data.zip,
    data.lossLocationSameAsAddress,
    propertyAddressText,
  ]);

  // Load reps on mount
  useEffect(() => { loadReps(); }, []);

  const checkForDuplicate = async () => {
    if (!data.address || !data.zip) return null;
    const addr = data.address.trim().toLowerCase();
    const zip = data.zip.trim();
    try {
      const [claimRes, inspRes] = await Promise.allSettled([
        supabase.from("claims").select("id, homeowner1, homeowner2, address, city, state, zip, signed_at").ilike("address", addr).eq("zip", zip).order("signed_at", { ascending: false }).limit(1),
        supabase.from("inspections").select("id, client_name, address, city, state, zip, signed_at, sales_rep_name").ilike("address", addr).eq("zip", zip).order("signed_at", { ascending: false }).limit(1),
      ]);
      const claim = claimRes.status === "fulfilled" && claimRes.value.data?.[0];
      const insp  = inspRes.status  === "fulfilled" && inspRes.value.data?.[0];
      if (claim) return { type: "claim", status: "signed", record: claim };
      if (insp)  return { type: "inspection", status: "signed", record: insp };
    } catch (e) { console.warn("Duplicate check failed:", e); }
    return null;
  };

  useEffect(() => {
    const loadFromSigningLink = async () => {
      const params = new URLSearchParams(window.location.search);
      const claimId = params.get("claim");
      const docs = params.get("docs");
      const sign = params.get("sign");

      if (!claimId || sign !== "1") return;

      setIsLoadingSigningLink(true);

      try {
        const docsFromLink = docs
          ? docs
              .split(",")
              .map((item) => item.trim())
              .filter((item) => VALID_DOCS.includes(item))
          : ["lor"];

        const { data: claim, error } = await supabase
          .from("claims")
          .select("*")
          .eq("id", claimId)
          .single();

        if (error || !claim) {
          alert("Unable to load signing request.");
          return;
        }

        setCurrentClaimId(claim.id);
        setSelectedDocs(docsFromLink.length ? docsFromLink : ["lor"]);
        setSignMode("now");
        setPendingSend(false);
        setIsSigningFromLink(true);
        setLorAgreed(false);
        setPacAgreed(false);
        setSubmitAttempted(false);

        setSig1(claim.signature1 || "");
        setSig2(claim.signature2 || "");

        setAuditInfo({
          signedAt: claim.signed_at || "",
          signedIp: claim.signed_ip || "",
          signedUserAgent: claim.signed_user_agent || "",
          signMethod: claim.sign_method || "",
          signedByEmail: claim.signed_by_email || claim.homeowner_email || "",
          signedByName:
            claim.signed_by_name ||
            [claim.homeowner1, claim.homeowner2].filter(Boolean).join(", "),
          signedCity: claim.signed_city || "",
          signedRegion: claim.signed_region || "",
        });

        setData((prev) => ({
          ...prev,
          date: claim.date || prev.date,
          insuranceCompany: claim.insurance_company || "",
          policyNumber: claim.policy_number || "",
          claimNumber: claim.claim_number || "",
          representativeName: claim.representative_name || "",
          homeowner1: claim.homeowner1 || "",
          homeowner2: claim.homeowner2 || "",
          phone: claim.phone || "",
          address: claim.address || "",
          city: claim.city || "",
          state: claim.state || "",
          zip: claim.zip || "",
          lossLocation: claim.loss_location || "",
          dateOfLoss: claim.date_of_loss || "",
          situation: claim.situation || "",
          signerEmail: claim.homeowner_email || "",
          paEmail: claim.pa_email || prev.paEmail,
          salesRepEmail: claim.sales_rep_email || prev.salesRepEmail,
          initials1: claim.initials1 || "",
          initials2: claim.initials2 || "",
          claimType: prev.claimType,
          lossDescription: prev.lossDescription,
          lossLocationSameAsAddress:
            (claim.loss_location || "") ===
            [
              claim.address,
              [claim.city, claim.state, claim.zip].filter(Boolean).join(", "),
            ]
              .filter(Boolean)
              .join("\n"),
        }));

        setView("review");
      } finally {
        setIsLoadingSigningLink(false);
      }
    };

    loadFromSigningLink();
  }, []);

  // JN team members fetch disabled — re-enable on test site when API key works

  useEffect(() => {
    if (view === "review" && reviewReady) {
      const timer = setTimeout(() => {
        const el = document.getElementById("signature-section");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 200);

      return () => clearTimeout(timer);
    }
  }, [view, reviewReady]);

  const update = (key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const parseJsonResponse = async (response, fallbackMessage) => {
    const rawText = await response.text();
    let result = {};

    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch {
      if (!response.ok) throw new Error(fallbackMessage);
      throw new Error(rawText || fallbackMessage);
    }

    if (!response.ok) {
      throw new Error(result.error || fallbackMessage);
    }

    return result;
  };

  const toggleDocSelection = (doc) => {
    setSelectedDocs((prev) => {
      if (prev.includes(doc)) {
        const next = prev.filter((item) => item !== doc);
        return next.length ? next : prev;
      }
      const next = [...prev, doc];
      return VALID_DOCS.filter((item) => next.includes(item));
    });
  };



  const beginDocumentFlow = async () => {
    if (!selectedDocs.length) {
      alert("Please select at least one form.");
      return;
    }

    // Check for duplicate address
    const dupe = await checkForDuplicate();
    if (dupe) {
      setDuplicateRecord(dupe);
      setView("duplicate");
      return;
    }

    setPendingSend(signMode === "send");
    setCurrentClaimId(null);
    setAuditInfo(initialAuditInfo);
    setSig1("");
    setSig2("");
    setTypedSig1("");
    setTypedSig2("");
    setSigMethod1("draw");
    setSigMethod2("draw");
    setInitialsMethod1("draw");
    setInitialsMethod2("draw");
    setData((prev) => ({ ...prev, initials1: "", initials2: "" }));
    setInitials1Typed("");
    setInitials2Typed("");
    setLorAgreed(false);
    setPacAgreed(false);
    setInspAgreed(false);
    setSubmitAttempted(false);
    setInspSig("");
    setInspTypedSig("");
    setInspSubmitAttempted(false);
    setInspectionOnly(false);
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Pre-populate inspection fields
    if (selectedDocs.includes("insp")) {
      setInspData(prev => ({
        ...prev,
        clientName: [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ") || prev.clientName,
        mobile: data.phone || prev.mobile,
        address: data.address || prev.address,
        city: data.city || prev.city,
        state: data.state || prev.state,
        zip: data.zip || prev.zip,
        email: data.signerEmail || prev.email,
      }));
    }

    // Send for signing — skip review page entirely, go straight to send
    if (signMode === "send") {
      setView("sending");
      return;
    }

    // Sign now — go to review page to authorize and sign
    setView("review");
  };

  const effectiveSig1 =
    sigMethod1 === "type" ? typedSignatureToDataUrl(typedSig1, sigFont1) : sig1;
  const effectiveSig2 =
    sigMethod2 === "type" ? typedSignatureToDataUrl(typedSig2, sigFont2) : sig2;

  const effectiveInitials1 =
    initialsMethod1 === "type"
      ? typedInitialsToDataUrl(initials1Typed, initialsFont1)
      : data.initials1;

  const effectiveInitials2 =
    initialsMethod2 === "type"
      ? typedInitialsToDataUrl(initials2Typed, initialsFont2)
      : data.initials2;

  const missingSigningFields = (() => {
    if (pendingSend) return [];
    const missing = [];
    if (!effectiveSig1) missing.push("Homeowner 1 signature");
    if (hasSecond && !effectiveSig2) missing.push("Homeowner 2 signature");
    if (selectedDocs.includes("pac")) {
      if (!effectiveInitials1) missing.push("Homeowner 1 initials");
      if (hasSecond && !effectiveInitials2) {
        missing.push("Homeowner 2 initials");
      }
    }
    return missing;
  })();

  const isSigningComplete = missingSigningFields.length === 0;

  const generatePDF = async (selector, filename) => {
    setIsExportingPdf(true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const element = document.querySelector(selector);
    if (!element) {
      setIsExportingPdf(false);
      throw new Error("Printable document not found.");
    }

    try {
      const opt = {
        margin: 0,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 1.5,
          useCORS: true,
          allowTaint: true,
          logging: false,
          ignoreElements: (el) => el.tagName === "IMG" && el.naturalWidth === 0,
          scrollX: 0,
          scrollY: 0,
        },
        jsPDF: {
          unit: "in",
          format: "letter",
          orientation: "portrait",
        },
        pagebreak: { mode: ["css"] },
      };

      return await html2pdf().set(opt).from(element).outputPdf("blob");
    } finally {
      setIsExportingPdf(false);
    }
  };

  const previewDocument = async (doc) => {
    try {
      const selector =
        doc === "lor" ? "#lor-printable-document" : "#pac-printable-document";
      const filename = documentFilename(doc);
      const blob = await generatePDF(selector, filename);
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      alert(err?.message || "Failed to open preview.");
    }
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const saveClaimToSupabase = async (audit = null) => {
    const payload = {
      date: data.date,
      insurance_company: data.insuranceCompany,
      policy_number: data.policyNumber,
      claim_number: data.claimNumber,
      sales_rep_name: data.salesRepName || "",
      sales_rep_email: data.salesRepEmail || "",
      sales_rep_id: data.salesRepId || "",
      docs_signed: selectedDocs.join(","),
      homeowner1: data.homeowner1,
      homeowner2: data.homeowner2,
      phone: data.phone,
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      loss_location: data.lossLocation,
      date_of_loss: data.dateOfLoss,
      situation: data.situation,
      homeowner_email: data.signerEmail,
      pa_email: data.paEmail,
      signature1: effectiveSig1,
      signature2: effectiveSig2,
      initials1: effectiveInitials1,
      initials2: effectiveInitials2,
      signed_at: audit?.signedAt || null,
      signed_ip: audit?.signedIp || null,
      signed_user_agent: audit?.signedUserAgent || null,
      sign_method: audit?.signMethod || null,
      signed_by_email: audit?.signedByEmail || null,
      signed_by_name: audit?.signedByName || null,
      signed_city: audit?.signedCity || null,
      signed_region: audit?.signedRegion || null,
    };

    if (currentClaimId) {
      const { data: updated, error } = await supabase
        .from("claims")
        .update(payload)
        .eq("id", currentClaimId)
        .select()
        .single();

      return { record: updated, error };
    }

    const { data: inserted, error } = await supabase
      .from("claims")
      .insert([payload])
      .select()
      .single();

    if (inserted?.id) setCurrentClaimId(inserted.id);
    return { record: inserted, error };
  };

  const submitInspection = async () => {
    setInspSubmitAttempted(true);
    if (!effectiveInspSig || !inspData.clientName || !inspData.address) {
      return;
    }
    setInspSubmitting(true);
    try {
      // Generate PDF
      const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
      const base64 = await blobToBase64(blob);
      const base64Content = String(base64).split(",")[1];

      // Save to Supabase inspections table
      const { error: inspSaveError } = await supabase.from("inspections").insert([{
        client_name: inspData.clientName,
        mobile: inspData.mobile,
        email: inspData.email,
        address: inspData.address,
        city: inspData.city,
        state: inspData.state,
        zip: inspData.zip,
        date: inspData.date,
        sales_rep_name: data.salesRepName || "",
        sales_rep_id: data.salesRepId || "",
        sales_rep_email: data.salesRepEmail || "",
        lead_source: data.leadSource || "NEED",
      }]);
      if (inspSaveError) {
        console.error("Inspection save error:", inspSaveError);
        alert("Warning: Could not save to database — " + inspSaveError.message);
      }

      // Email to homeowner
      if (inspData.email) {
        // Generate USS welcome PDF
        let ussWelcomeAttachment = null;
        try {
          const ussBlob = await generatePDF("#uss-welcome-printable", "USS-Welcome-Package.pdf");
          const ussBase64 = await blobToBase64(ussBlob);
          ussWelcomeAttachment = { filename: "USS-Welcome-Package.pdf", content: String(ussBase64).split(",")[1] };
        } catch(e) { console.warn("USS welcome PDF failed:", e); }

        const inspAttachments = [{ filename: "Free-Roof-Inspection-Agreement.pdf", content: base64Content }];
        if (ussWelcomeAttachment) inspAttachments.push(ussWelcomeAttachment);

        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [inspData.email],
            subject: "Your Free Roof Inspection Agreement — U.S. Shingle & Metal",
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: #1a2e5a; padding: 24px 32px; border-radius: 12px 12px 0 0;">
                  <h1 style="color: #fff; margin: 0; font-size: 22px;">🏠 Your Inspection Agreement</h1>
                </div>
                <div style="background: #f9fafb; padding: 24px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <p style="font-size: 15px; color: #374151;">Hi ${inspData.clientName},</p>
                  <p style="font-size: 15px; color: #374151; line-height: 1.6;">
                    Thank you for signing your Free Roof Inspection Agreement with U.S. Shingle & Metal LLC.
                    Your signed agreement and welcome package are attached. We will be in touch shortly to schedule your inspection.
                  </p>
                  <div style="background: #eef1f8; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px 20px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: 700; color: #1a2e5a;">📎 Attached:</p>
                    <ul style="margin: 8px 0 0; padding-left: 18px; color: #374151; font-size: 14px; line-height: 1.8;">
                      <li>Free Roof Inspection Agreement (signed copy)</li>
                      <li>USS Welcome Package — what to expect next</li>
                    </ul>
                  </div>
                  <div style="background: #1a2e5a; border-radius: 10px; padding: 16px 20px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: 700; color: #fff;">📞 Questions? Contact us:</p>
                    <p style="margin: 6px 0 0; color: rgba(255,255,255,0.85); font-size: 14px;">
                      Phone: ${ussContactPhone}<br/>Email: ${ussContactEmail}
                    </p>
                  </div>
                </div>
              </div>
            `,
            attachments: inspAttachments,
            bcc: activityEmail ? [activityEmail] : [],
          }),
        }).catch(e => console.warn("Homeowner email non-fatal:", e));
      }

      // Job Nimbus sync disabled until API key is fixed
      // fetch("/.netlify/functions/jobnimbus-sync", ...

      // Reset inspection sig fields
      setInspSig("");
      setInspTypedSig("");
      setInspSubmitAttempted(false);

      // ── Activity notification email ──
      if (activityEmail) {
        const repName = data.salesRepName || "—";
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [activityEmail],
            subject: `🏠 New Inspection — ${inspData.clientName} (${repName})`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #1a2e5a; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">🏠 New Inspection Signed</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Client:</td><td>${inspData.clientName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${[inspData.address, inspData.city, inspData.state, inspData.zip].filter(Boolean).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Rep:</td><td>${repName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Doc:</td><td>Free Roof Inspection Agreement</td></tr>
                    ${inspData.mobile ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${inspData.mobile}</td></tr>` : ""}
                    ${inspData.email ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${inspData.email}</td></tr>` : ""}
                  </table>
                </div>
              </div>
            `,
          }),
        }).catch(e => console.warn("Activity email non-fatal:", e));
      }

      // Go to thank you page
      window.scrollTo({ top: 0, behavior: "smooth" });
      setInspectionOnly(true);
      setView("thankyou");

    } catch (err) {
      alert(err?.message || "Something went wrong. Please try again.");
    } finally {
      setInspSubmitting(false);
    }
  };

  const submitDoc = async () => {
    try {
      setSubmitAttempted(true);
      if (!pendingSend && !isSigningComplete) {
        return;
      }
      setIsSubmitting(true);

      if (pendingSend) {
        const { record, error } = await saveClaimToSupabase(null);
        if (error) {
          alert("Error saving: " + error.message);
          return;
        }

        const params = new URLSearchParams({
          sign: "1",
          docs: selectedDocs.join(","),
          claim: String(record?.id || ""),
        });

        const signingLink = `${window.location.origin}/?${params.toString()}`;

        const emailResponse = await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [data.signerEmail].filter(Boolean),
            subject:
              selectedDocs.length > 1
                ? "Please Sign: Claim Documents"
                : `Please Sign: ${documentLabel(selectedDocs[0])}`,
            html: `
              <h2>Signature Requested</h2>
              <p>Please click the link below to review and sign your document${
                selectedDocs.length > 1 ? "s" : ""
              }.</p>
              <p><a href="${signingLink}">${signingLink}</a></p>
              <p><strong>Forms included:</strong></p>
              <ul>${selectedDocs
                .map((doc) => `<li>${documentLabel(doc)}</li>`)
                .join("")}</ul>
              <p><strong>Important:</strong> You can draw your signature or use the bold typed-signature option if you are on a computer without a touchscreen.</p>
            `,
          }),
        });

        await parseJsonResponse(emailResponse, "Signing email failed.");
        setIsSubmitting(false);
        setView("input");
        setPendingSend(false);
        return;
      }

      let nextAuditInfo = {
        signedAt: new Date().toISOString(),
        signedIp: "",
        signedUserAgent: navigator.userAgent || "",
        signMethod: isSigningFromLink ? "email_link" : "sign_now",
        signedByEmail: data.signerEmail || "",
        signedByName: [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
        signedCity: "",
        signedRegion: "",
      };

      try {
        const auditResponse = await fetch("/.netlify/functions/sign-audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            claimId: currentClaimId,
            docType: selectedDocs.join(","),
            signMethod: isSigningFromLink ? "email_link" : "sign_now",
            signedByEmail: data.signerEmail,
            signedByName: [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
          }),
        });
        const serverAudit = await parseJsonResponse(auditResponse, "Audit failed.");
        nextAuditInfo = {
          signedAt: serverAudit.signedAt || nextAuditInfo.signedAt,
          signedIp: serverAudit.signedIp || "",
          signedUserAgent: serverAudit.signedUserAgent || navigator.userAgent || "",
          signMethod: serverAudit.signMethod || nextAuditInfo.signMethod,
          signedByEmail: serverAudit.signedByEmail || data.signerEmail || "",
          signedByName: serverAudit.signedByName || nextAuditInfo.signedByName,
          signedCity: serverAudit.signedCity || "",
          signedRegion: serverAudit.signedRegion || "",
        };
      } catch(auditErr) {
        console.warn("Audit non-fatal:", auditErr);
      }

      setAuditInfo(nextAuditInfo);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Only save to claims table if PA docs are included
      if (selectedDocs.includes("lor") || selectedDocs.includes("pac")) {
        const { error } = await saveClaimToSupabase(nextAuditInfo);
        if (error) {
          console.warn("Claims save error:", error.message);
        }
      }

      const attachments = [];

      if (selectedDocs.includes("insp")) {
        // Save to inspections table
        await supabase.from("inspections").insert([{
          client_name: [data.homeowner1, data.homeowner2].filter(Boolean).join(" & "),
          mobile: data.phone,
          email: data.signerEmail,
          address: data.address,
          city: data.city,
          state: data.state,
          zip: data.zip,
          date: data.date,
          sales_rep_name: data.salesRepName || "",
          sales_rep_id: data.salesRepId || "",
          sales_rep_email: data.salesRepEmail || "",
          lead_source: data.leadSource || "NEED",
        }]).then(({ error }) => {
          if (error) console.error("Inspection insert error:", error);
        });

        try {
          const inspBlob = await generatePDF(
            "#inspection-printable",
            documentFilename("insp")
          );
          const inspBase64 = await blobToBase64(inspBlob);
          attachments.push({
            filename: documentFilename("insp"),
            content: String(inspBase64).split(",")[1],
          });
        } catch (e) {
          console.warn("Inspection PDF failed:", e);
        }
      }

      if (selectedDocs.includes("lor")) {
        const lorBlob = await generatePDF(
          "#lor-printable-document",
          documentFilename("lor")
        );
        const lorBase64 = await blobToBase64(lorBlob);
        attachments.push({
          filename: documentFilename("lor"),
          content: String(lorBase64).split(",")[1],
        });
      }

      if (selectedDocs.includes("pac")) {
        const pacBlob = await generatePDF(
          "#pac-printable-document",
          documentFilename("pac")
        );
        const pacBase64 = await blobToBase64(pacBlob);
        attachments.push({
          filename: documentFilename("pac"),
          content: String(pacBase64).split(",")[1],
        });
      }

      // Always attach the welcome package PDF
      try {
        const welcomeBlob = await generatePDF(
          "#ty-summary-printable",
          "CCG-Welcome-Package.pdf"
        );
        const welcomeBase64 = await blobToBase64(welcomeBlob);
        attachments.push({
          filename: "CCG-Welcome-Package.pdf",
          content: String(welcomeBase64).split(",")[1],
        });
      } catch (e) {
        console.warn("Welcome package PDF failed, skipping:", e);
      }

      const finalEmailResponse = await fetch("/.netlify/functions/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [data.signerEmail].filter(Boolean),
          bcc: activityEmail ? [activityEmail] : [],
          subject: "Your Signed Documents — Capital Claims Group",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #199c2e; padding: 28px 32px; border-radius: 12px 12px 0 0;">
                <h1 style="color: #fff; margin: 0; font-size: 24px;">🎉 You're All Set!</h1>
              </div>
              <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                <p style="font-size: 16px; color: #111827; margin-top: 0;">
                  Hi ${[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")},
                </p>
                <p style="font-size: 15px; color: #374151; line-height: 1.6;">
                  Your documents are signed and we're officially on the case.
                  <strong>We've attached everything to this email</strong> for your records:
                </p>
                <ul style="font-size: 15px; color: #374151; line-height: 1.8;">
                  ${selectedDocs.map(d => `<li><strong>${documentLabel(d)}</strong> — your signed copy</li>`).join("")}
                  <li><strong>CCG Welcome Package</strong> — what to expect next &amp; our contact info</li>
                </ul>
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 18px 20px; margin: 20px 0;">
                  <p style="margin: 0 0 8px; font-weight: 700; color: #166534;">📞 Need to reach us?</p>
                  <p style="margin: 0; color: #166534; font-size: 14px; line-height: 1.7;">
                    Phone: +1 (954) 571-3035<br/>
                    Email: claims@capitalclaimgroup.com<br/>
                    Website: www.ccgclaims.com
                  </p>
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">
                  <em>Signed at: ${nextAuditInfo.signedAt || ""}</em>
                </p>
              </div>
            </div>
          `,
          attachments,
        }),
      });

      try { await parseJsonResponse(finalEmailResponse, "Homeowner email failed."); }
      catch(emailErr) { console.warn("Homeowner email error (non-fatal):", emailErr); }

      // ── PA notification email — different content based on claim stage ──
      const isPostInspection = data.claimStage === "post_inspection";
      const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ") || "Homeowner";
      const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");

      const paSubject = isPostInspection
        ? `✅ Signed PA Docs — ${homeownerName} (Damage Confirmed)`
        : `📋 Signed PA Docs — ${homeownerName} (Inspection Pending)`;

      const paHtml = isPostInspection ? `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1e40af; padding: 24px 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ Damage Confirmed — Docs Signed</h1>
          </div>
          <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="font-size: 15px; color: #374151; line-height: 1.6; margin-top: 0;">
              You inspected this property and confirmed damage. The homeowner has now signed all required documents and is ready to move forward with the claim.
            </p>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 18px 20px; margin: 20px 0;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #1e40af; font-size: 15px;">👤 Homeowner Details</p>
              <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 4px 0; font-weight: 600; width: 140px;">Name:</td><td>${homeownerName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Address:</td><td>${homeownerAddress}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Phone:</td><td>${data.phone || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Email:</td><td>${data.signerEmail || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Insurance Co.:</td><td>${data.insuranceCompany || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Policy #:</td><td>${data.policyNumber || "—"}</td></tr>
                ${data.claimNumber ? `<tr><td style="padding: 4px 0; font-weight: 600;">Claim #:</td><td>${data.claimNumber}</td></tr>` : ""}
                ${data.dateOfLoss ? `<tr><td style="padding: 4px 0; font-weight: 600;">Date of Loss:</td><td>${data.dateOfLoss}</td></tr>` : ""}
              </table>
            </div>

            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              The signed documents are attached. You're good to proceed with filing the claim.
            </p>
            <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
              <em>Signed at: ${nextAuditInfo.signedAt || ""} &nbsp;|&nbsp; IP: ${nextAuditInfo.signedIp || ""}</em>
            </p>
          </div>
        </div>
      ` : `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #d97706; padding: 24px 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: #fff; margin: 0; font-size: 22px;">📋 Signed Docs — Inspection Needed</h1>
          </div>
          <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="font-size: 15px; color: #374151; line-height: 1.6; margin-top: 0;">
              The homeowner has signed the paperwork. <strong>The roof has not been inspected yet</strong> — the inspection should be scheduled within the week. Please watch for this job in <strong>Job Nimbus</strong> and assign the inspection accordingly.
            </p>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 14px 18px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 700; color: #92400e; font-size: 14px;">⚠️ Action Required: Schedule roof inspection within the week</p>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; margin: 16px 0;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #111827; font-size: 15px;">👤 Homeowner Details</p>
              <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 4px 0; font-weight: 600; width: 140px;">Name:</td><td>${homeownerName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Address:</td><td>${homeownerAddress}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Phone:</td><td>${data.phone || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Email:</td><td>${data.signerEmail || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Insurance Co.:</td><td>${data.insuranceCompany || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Policy #:</td><td>${data.policyNumber || "—"}</td></tr>
              </table>
            </div>

            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              Signed documents are attached for your records. Once the inspection confirms damage, proceed with the PA claim process.
            </p>
            <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
              <em>Signed at: ${nextAuditInfo.signedAt || ""} &nbsp;|&nbsp; IP: ${nextAuditInfo.signedIp || ""}</em>
            </p>
          </div>
        </div>
      `;

      // Only send PA email if PA docs were included
      if (data.paEmail && (selectedDocs.includes("lor") || selectedDocs.includes("pac"))) {
        const paEmailResponse = await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [data.paEmail],
            subject: paSubject,
            html: paHtml,
            attachments,
          }),
        });
        try { await parseJsonResponse(paEmailResponse, "PA notification email failed."); }
        catch(e) { console.warn("PA email non-fatal:", e); }
      }

      // ── Activity notification email ──
      if (activityEmail) {
        const repName = data.salesRepName || data.representativeName || "—";
        const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ");
        const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [activityEmail],
            subject: `📋 New Signing — ${homeownerName} (${repName})`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #199c2e; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">📋 New Signing Activity</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Homeowner:</td><td>${homeownerName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${homeownerAddress}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Rep:</td><td>${repName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Docs:</td><td>${selectedDocs.map(d => documentLabel(d)).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Stage:</td><td>${data.claimStage === "post_inspection" ? "✅ Roof Inspected" : "🏠 Pre-Inspection"}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Signed:</td><td>${nextAuditInfo.signedAt || new Date().toLocaleString()}</td></tr>
                    ${data.phone ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${data.phone}</td></tr>` : ""}
                    ${data.signerEmail ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${data.signerEmail}</td></tr>` : ""}
                  </table>
                </div>
              </div>
            `,
          }),
        }).catch(e => console.warn("Activity email non-fatal:", e));
      }

      // ── Rep notification email ──
      if (data.salesRepEmail) {
        const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ");
        const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [data.salesRepEmail],
            subject: `✅ Signed — ${homeownerName}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #199c2e; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">✅ Your client just signed!</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Homeowner:</td><td>${homeownerName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${homeownerAddress}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Docs signed:</td><td>${selectedDocs.map(d => documentLabel(d)).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Stage:</td><td>${data.claimStage === "post_inspection" ? "✅ Roof Inspected" : "🏠 Pre-Inspection"}</td></tr>
                    ${data.phone ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${data.phone}</td></tr>` : ""}
                    ${data.signerEmail ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${data.signerEmail}</td></tr>` : ""}
                    ${data.insuranceCompany ? `<tr><td style="padding: 5px 0; font-weight: 700;">Insurance:</td><td>${data.insuranceCompany}</td></tr>` : ""}
                    ${data.policyNumber ? `<tr><td style="padding: 5px 0; font-weight: 700;">Policy #:</td><td>${data.policyNumber}</td></tr>` : ""}
                  </table>
                  <div style="margin-top: 16px; background: #f0fdf4; border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #166534; font-weight: 600;">
                    Signed PDFs have been emailed to the homeowner and PA. Your copy is attached.
                  </div>
                </div>
              </div>
            `,
            attachments,
          }),
        }).catch(e => console.warn("Rep email non-fatal:", e));
      }
      setPendingSend(false);

      // ── Job Nimbus sync disabled until API key is fixed ──


      window.scrollTo({ top: 0, behavior: "smooth" });
      if (isSigningFromLink) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      // Set inspectionOnly flag — insp signed but no PA docs
      setInspectionOnly(selectedDocs.includes("insp") && !selectedDocs.includes("lor") && !selectedDocs.includes("pac"));
      setView("thankyou");
    } catch (err) {
      setIsSubmitting(false);
      alert(err?.message || "Something went wrong. Please try again.");
    }
  };

  if (isLoadingSigningLink) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f1f5f9",
          fontFamily: "'Oswald', Arial, Helvetica, sans-serif",
        }}
      >
        Loading signing request...
      </div>
    );
  }

  // Reusable inline style for the friendly toggle pill button

  const sigSectionLabel = (emoji, title, subtitle) => (
    <div style={{ marginBottom: 12, marginTop: 20 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 28 }}>{emoji}</span>
        <span style={{
          fontSize: 20,
          fontWeight: 700,
          color: "#111827",
          fontFamily: "'Nunito', sans-serif",
        }}>{title}</span>
      </div>
      {subtitle ? (
        <div style={{
          fontSize: 15,
          color: "#6b7280",
          fontFamily: "'Nunito', sans-serif",
          lineHeight: 1.5,
          paddingLeft: 38,
        }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );

  const renderSigningFields = (showSendMode = false) => (
    <div>
      {/* ── Header strip ── */}
      {!showSendMode ? (
        <div
          style={{
            background: "linear-gradient(135deg, #199c2e, #15803d)",
            borderRadius: "24px 24px 0 0",
            padding: "28px 28px 24px",
            color: "#fff",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 6 }}>✍️</div>
          <div style={{
            fontSize: 30,
            fontWeight: 700,
            fontFamily: "'Oswald', sans-serif",
            marginBottom: 8,
            lineHeight: 1.1,
          }}>
            One Last Step — Sign Here!
          </div>
          <div style={{
            fontSize: 17,
            fontFamily: "'Nunito', sans-serif",
            fontWeight: 600,
            opacity: 0.92,
            lineHeight: 1.6,
            maxWidth: 520,
          }}>
            Use your finger, mouse, or just type your name below. It only takes 30 seconds. 🎉
          </div>
        </div>
      ) : null}

      <Card style={{ borderRadius: showSendMode ? 24 : "0 0 24px 24px", borderTop: showSendMode ? undefined : "none" }}>
        {showSendMode ? (
          <CardHeader>
            <CardTitle>Review & Send for Signing</CardTitle>
            <CardDescription>Review the selected forms, then email one signing link to the homeowner.</CardDescription>
          </CardHeader>
        ) : null}

        <CardContent>
          {!showSendMode ? (
            <>
              {!reviewReady && submitAttempted ? (
                <div style={{
                  background: "#fef9c3",
                  color: "#713f12",
                  border: "1px solid #fde68a",
                  borderRadius: 14,
                  padding: "14px 18px",
                  marginBottom: 20,
                  fontSize: 16,
                  fontWeight: 700,
                  fontFamily: "'Nunito', sans-serif",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}>
                  <span style={{ fontSize: 22 }}>👆</span>
                  Scroll up and tap "Looks Good!" on each document first!
                </div>
              ) : null}

              {/* ── HOW TO SIGN — two big friendly option cards ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{
                  fontSize: 16,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "#111827",
                  fontFamily: "'Oswald', sans-serif",
                  marginBottom: 12,
                }}>
                  ✏️ Choose How to Sign:
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {/* Option A: Draw */}
                  <button
                    type="button"
                    onClick={() => { setSigMethod1("draw"); setSigMethod2("draw"); }}
                    style={{
                      padding: "18px 14px",
                      borderRadius: 18,
                      border: sigMethod1 === "draw" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                      background: sigMethod1 === "draw" ? "#f0fdf4" : "#fff",
                      cursor: "pointer",
                      textAlign: "center",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ fontSize: 36, marginBottom: 8 }}>👆</div>
                    <div style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#111827",
                      fontFamily: "'Nunito', sans-serif",
                      marginBottom: 4,
                    }}>
                      Draw Your Signature
                    </div>
                    <div style={{
                      fontSize: 13,
                      color: "#6b7280",
                      fontFamily: "'Nunito', sans-serif",
                      lineHeight: 1.4,
                    }}>
                      Use your finger or mouse in the box
                    </div>
                    {sigMethod1 === "draw" ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>

                  {/* Option B: Type */}
                  <button
                    type="button"
                    onClick={() => { setSigMethod1("type"); setSigMethod2("type"); setInitialsMethod1("type"); setInitialsMethod2("type"); }}
                    style={{
                      padding: "18px 14px",
                      borderRadius: 18,
                      border: sigMethod1 === "type" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                      background: sigMethod1 === "type" ? "#f0fdf4" : "#fff",
                      cursor: "pointer",
                      textAlign: "center",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ fontSize: 36, marginBottom: 8 }}>⌨️</div>
                    <div style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#111827",
                      fontFamily: "'Nunito', sans-serif",
                      marginBottom: 4,
                    }}>
                      Type Your Signature
                    </div>
                    <div style={{
                      fontSize: 13,
                      color: "#6b7280",
                      fontFamily: "'Nunito', sans-serif",
                      lineHeight: 1.4,
                    }}>
                      Type your name &amp; pick a style
                    </div>
                    {sigMethod1 === "type" ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>
                </div>
              </div>

              {/* ── Signature field ── */}
              {sigSectionLabel("🖊️", data.homeowner1 ? `${data.homeowner1}'s Signature` : "Your Signature", null)}

              {sigMethod1 === "draw" ? (
                <SignaturePad
                  title=""
                  value={sig1}
                  onChange={setSig1}
                  required
                  missing={submitAttempted && !effectiveSig1}
                />
              ) : (
                <TypedSignatureField
                  title=""
                  value={typedSig1}
                  onChange={setTypedSig1}
                  fontValue={sigFont1}
                  onFontChange={setSigFont1}
                  required
                  missing={submitAttempted && !effectiveSig1}
                  placeholder="Type your full legal name"
                />
              )}

              {hasSecond ? (
                <>
                  {sigSectionLabel("🖊️", data.homeowner2 ? `${data.homeowner2}'s Signature` : "Co-Owner Signature", null)}
                  {sigMethod2 === "draw" ? (
                    <SignaturePad
                      title=""
                      value={sig2}
                      onChange={setSig2}
                      required
                      missing={submitAttempted && !effectiveSig2}
                    />
                  ) : (
                    <TypedSignatureField
                      title=""
                      value={typedSig2}
                      onChange={setTypedSig2}
                      fontValue={sigFont2}
                      onFontChange={setSigFont2}
                      required
                      missing={submitAttempted && !effectiveSig2}
                      placeholder="Type co-owner's full legal name"
                    />
                  )}
                </>
              ) : null}

              {selectedDocs.includes("pac") ? (
                <>
                  {/* ── Initials intro banner ── */}
                  <div style={{
                    marginTop: 28,
                    marginBottom: 20,
                    borderRadius: 20,
                    background: "linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)",
                    border: "2px solid #86efac",
                    padding: "20px 24px",
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                  }}>
                    <div style={{
                      fontSize: 48,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}>
                      🎉
                    </div>
                    <div>
                      <div style={{
                        fontSize: 22,
                        fontWeight: 800,
                        color: "#15803d",
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: "0.02em",
                        marginBottom: 4,
                        lineHeight: 1.1,
                      }}>
                        Almost There — Just Initials!
                      </div>
                      <div style={{
                        fontSize: 16,
                        color: "#166534",
                        fontFamily: "'Nunito', sans-serif",
                        fontWeight: 600,
                        lineHeight: 1.55,
                      }}>
                        One tiny step left — just pop your initials in the box below. Same as before, draw or type! 😊
                      </div>
                    </div>
                  </div>

                  {sigSectionLabel("✏️", data.homeowner1 ? `${data.homeowner1}'s Initials` : "Your Initials", null)}

                  {initialsMethod1 === "draw" ? (
                    <InitialsPad
                      title=""
                      value={data.initials1}
                      onChange={(v) => update("initials1", v)}
                      required
                      missing={submitAttempted && !effectiveInitials1}
                    />
                  ) : (
                    <TypedInitialsField
                      title=""
                      value={initials1Typed}
                      onChange={setInitials1Typed}
                      fontValue={initialsFont1}
                      onFontChange={setInitialsFont1}
                      required
                      missing={submitAttempted && !effectiveInitials1}
                      placeholder="Your initials (e.g. JD)"
                    />
                  )}

                  {hasSecond ? (
                    <>
                      {sigSectionLabel("✏️", data.homeowner2 ? `${data.homeowner2}'s Initials` : "Co-Owner Initials", null)}
                      {initialsMethod2 === "draw" ? (
                        <InitialsPad
                          title=""
                          value={data.initials2}
                          onChange={(v) => update("initials2", v)}
                          required
                          missing={submitAttempted && !effectiveInitials2}
                        />
                      ) : (
                        <TypedInitialsField
                          title=""
                          value={initials2Typed}
                          onChange={setInitials2Typed}
                          fontValue={initialsFont2}
                          onFontChange={setInitialsFont2}
                          required
                          missing={submitAttempted && !effectiveInitials2}
                          placeholder="Co-owner initials (e.g. JD)"
                        />
                      )}
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {!showSendMode && submitAttempted && missingSigningFields.length > 0 ? (
            <div style={{
              marginTop: 16,
              marginBottom: 12,
              padding: "14px 18px",
              background: "#fef2f2",
              borderRadius: 14,
              fontSize: 15,
              color: "#991b1b",
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              Almost there! Still needed: {missingSigningFields.join(", ")}
            </div>
          ) : null}

        <div
          style={{
            display: "flex",
            gap: 12,
            paddingTop: 8,
            flexWrap: "wrap",
          }}
        >
          <Button
            onClick={submitDoc}
            disabled={
              isSubmitting || (showSendMode ? false : !reviewReady || !isSigningComplete)
            }
          >
            {showSendMode ? <Send size={16} /> : <Mail size={16} />}
            {showSendMode ? "Send for Signing" : "Submit & Email Copies"}
          </Button>

          <Button
            variant="outline"
            onClick={async () => {
              try {
                const selector = selectedDocs.includes("lor")
                  ? "#lor-printable-document"
                  : "#pac-printable-document";
                const filename = selectedDocs.includes("lor")
                  ? documentFilename("lor")
                  : documentFilename("pac");

                const element = document.querySelector(selector);
                if (!element) {
                  alert("Document not found.");
                  return;
                }

                setIsExportingPdf(true);
                await new Promise((resolve) => setTimeout(resolve, 200));

                await html2pdf()
                  .set({
                    margin: 0,
                    filename,
                    image: { type: "jpeg", quality: 0.98 },
                    html2canvas: {
                      scale: 1.5,
                      useCORS: true,
                      scrollX: 0,
                      scrollY: 0,
                    },
                    jsPDF: {
                      unit: "in",
                      format: "letter",
                      orientation: "portrait",
                    },
                    pagebreak: { mode: ["css"] },
                  })
                  .from(element)
                  .save();
              } catch (err) {
                alert(err?.message || "Failed to download PDF.");
              } finally {
                setIsExportingPdf(false);
              }
            }}
          >
            Download PDF
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        padding: 16,
        boxSizing: "border-box",
      }}
    >

      {/* ── Always-rendered hidden USS Welcome PDF ── */}
      <div style={{ position: "absolute", left: "-20000px", top: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div id="uss-welcome-printable" style={{ width: "8.5in", fontFamily: "Arial, Helvetica, sans-serif", background: "#fff" }}>
          <div style={{ width: "8.5in", boxSizing: "border-box", padding: "0.7in 0.75in", minHeight: "11in" }}>
            <div style={{ display: "flex", height: 8, marginBottom: 24 }}>
              <div style={{ flex: 1, background: "#c8392b" }} />
              <div style={{ flex: 1, background: "#e5e7eb" }} />
              <div style={{ flex: 1, background: "#1a2e5a" }} />
            </div>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#1a2e5a", fontFamily: "Arial, Helvetica, sans-serif", letterSpacing: 1 }}>U.S. Shingle & Metal LLC</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>3845 Gateway Centre Blvd Suite 300 • Pinellas Park, FL 33782</div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Phone: 727.761.5200 • Email: info@shingleusa.com • License: CCC1331960</div>
            </div>
            <div style={{ borderBottom: "2px solid #1a2e5a", marginBottom: 28 }} />
            <div style={{ fontSize: 22, fontWeight: 700, color: "#1a2e5a", marginBottom: 14 }}>Welcome, {[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ") || inspData.clientName}!</div>
            <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.75, marginBottom: 20 }}>
              Thank you for choosing U.S. Shingle & Metal LLC for your free roof inspection. We are a licensed and fully insured roofing contractor dedicated to helping homeowners navigate storm damage with honesty and professionalism.
            </p>
            <div style={{ background: "#eef1f8", borderRadius: 10, padding: "18px 22px", marginBottom: 22 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1a2e5a", marginBottom: 12 }}>{ussWelcomeHeading}</div>
              {ussWelcomeSteps.map((step, i) => (
                <div key={i} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#1a2e5a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                  <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>{step}</div>
                </div>
              ))}
            </div>
            <div style={{ background: "#1a2e5a", borderRadius: 10, padding: "18px 22px", color: "#fff", marginBottom: 22 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Contact Us Anytime</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                📞 Phone: {ussContactPhone}<br/>
                📧 Email: {ussContactEmail}<br/>
                📍 3845 Gateway Centre Blvd Suite 300, Pinellas Park, FL 33782<br/>
                🪪 License: CCC1331960
              </div>
            </div>
            <div style={{ display: "flex", height: 8, marginTop: 32 }}>
              <div style={{ flex: 1, background: "#c8392b" }} />
              <div style={{ flex: 1, background: "#e5e7eb" }} />
              <div style={{ flex: 1, background: "#1a2e5a" }} />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Nunito:wght@400;500;600;700&display=swap');
        body {
          margin: 0;
          font-family: 'Nunito', Arial, Helvetica, sans-serif;
        }
        input, textarea, select {
          font-family: 'Nunito', Arial, Helvetica, sans-serif;
        }
        button {
          font-family: 'Oswald', Arial, Helvetica, sans-serif;
        }
      `}</style>

      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "grid",
          gap: 24,
        }}
      >
        {view === "input" ? (
          <Card>
            <CardHeader>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <CardTitle>Claim Intake</CardTitle>
                  <CardDescription>
                    Enter the information once, choose sign now or send for signing,
                    choose which forms to include, then continue.
                  </CardDescription>
                </div>
                <button
                  type="button"
                  onClick={() => setView("manager")}
                  style={{
                    background: "transparent",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    padding: "6px 14px",
                    fontSize: 12,
                    fontFamily: "'Oswald', sans-serif",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    color: "#6b7280",
                    cursor: "pointer",
                    textTransform: "uppercase",
                    flexShrink: 0,
                    marginTop: 4,
                  }}
                >
                  ⚙️ Manager
                </button>
              </div>
            </CardHeader>

            <CardContent>
              <div style={{ display: "grid", gap: 24 }}>
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Homeowner Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="Homeowner 1"
                      value={data.homeowner1}
                      onChange={(v) => update("homeowner1", v)}
                    />
                    <FormField
                      label="Homeowner 2"
                      value={data.homeowner2}
                      onChange={(v) => update("homeowner2", v)}
                    />
                    <div>
                      <label style={{
                        display: "block",
                        fontSize: 14,
                        color: "#374151",
                        marginBottom: 8,
                        fontWeight: 600,
                        fontFamily: "'Nunito', sans-serif",
                      }}>Phone</label>
                      <input
                        type="tel"
                        value={data.phone}
                        placeholder="(813) 656-4161"
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                          let formatted = digits;
                          if (digits.length >= 7) {
                            formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
                          } else if (digits.length >= 4) {
                            formatted = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
                          } else if (digits.length >= 1) {
                            formatted = `(${digits}`;
                          }
                          update("phone", formatted);
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                    <FormField
                      label="Homeowner Email"
                      type="email"
                      value={data.signerEmail}
                      onChange={(v) => update("signerEmail", v)}
                    />
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FormField
                        label="Address"
                        value={data.address}
                        onChange={(v) => update("address", v)}
                      />
                    </div>
                    <FormField
                      label="City"
                      value={data.city}
                      onChange={(v) => update("city", v)}
                    />
                    <FormField
                      label="State"
                      value={data.state}
                      onChange={(v) => update("state", v)}
                    />
                    <FormField
                      label="ZIP"
                      value={data.zip}
                      onChange={(v) => update("zip", v)}
                    />
                  </div>
                </Card>

                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Claim Admin</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="Today's Date"
                      type="date"
                      value={data.date}
                      onChange={(v) => update("date", v)}
                    />
                    <FormField
                      label="Insurance Company"
                      value={data.insuranceCompany}
                      onChange={(v) => update("insuranceCompany", v)}
                    />
                    <FormField
                      label="Policy #"
                      value={data.policyNumber}
                      onChange={(v) => update("policyNumber", v)}
                    />
                    <div>
                      <FormField
                        label="Claim #"
                        value={data.claimNumber}
                        onChange={(v) => update("claimNumber", v)}
                      />
                      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                        Only fill this out if there is an active claim.
                      </div>
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <CheckboxField
                        label="Loss location is same as property address"
                        checked={data.lossLocationSameAsAddress}
                        onChange={(checked) => update("lossLocationSameAsAddress", checked)}
                      />
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <FormField
                        label="Loss Location"
                        value={data.lossLocation}
                        onChange={(v) => update("lossLocation", v)}
                        disabled={data.lossLocationSameAsAddress}
                      />
                    </div>
                  </div>
                </Card>

                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Office Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="PA Email"
                      type="email"
                      value={data.paEmail}
                      onChange={(v) => update("paEmail", v)}
                    />

                    {/* Lead Source */}
                    <div>
                      <Label>Lead Source</Label>
                      <div style={{ display: "flex", gap: 10 }}>
                        {["NEED", "INS"].map((src) => (
                          <button
                            key={src}
                            type="button"
                            onClick={() => update("leadSource", src)}
                            style={{
                              flex: 1,
                              padding: "10px 8px",
                              borderRadius: 12,
                              border: data.leadSource === src ? "2.5px solid #199c2e" : "1.5px solid #d1d5db",
                              background: data.leadSource === src ? "#f0fdf4" : "#fff",
                              color: data.leadSource === src ? "#166534" : "#374151",
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700,
                              fontSize: 15,
                              cursor: "pointer",
                              letterSpacing: "0.05em",
                            }}
                          >
                            {src}
                          </button>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                        {data.leadSource === "NEED" ? "New lead — will create contact + job in JN" : "Existing lead — will search JN by address"}
                      </div>
                    </div>

                    {/* Sales Rep dropdown */}
                    <div>
                      <Label>Sales Rep</Label>
                      <select
                        value={data.salesRepId}
                        onChange={(e) => {
                          const selected = reps.find(r => r.id === e.target.value);
                          update("salesRepId", e.target.value);
                          update("salesRepName", selected?.name || "");
                          update("salesRepEmail", selected?.email || "");
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                          background: "#fff",
                          fontFamily: "'Nunito', sans-serif",
                        }}
                      >
                        <option value="">— Select Rep —</option>
                        {reps.filter(r => r.active !== false).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      {reps.length === 0 ? (
                        <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          ⚠️ No reps loaded — go to Manager → Sales Rep Manager to import
                        </div>
                      ) : null}
                    </div>

                    {/* Rep Email — auto-fills from rep record, saves back if edited */}
                    <div>
                      <Label>Rep Email</Label>
                      <input
                        type="email"
                        value={data.salesRepEmail}
                        placeholder="Rep's email address"
                        onChange={(e) => update("salesRepEmail", e.target.value)}
                        onBlur={async (e) => {
                          const email = e.target.value.trim();
                          if (!email || !data.salesRepId) return;
                          const rep = reps.find(r => r.id === data.salesRepId);
                          if (rep && rep.email !== email) {
                            await supabase.from("sales_reps").update({ email }).eq("id", data.salesRepId);
                            await loadReps();
                          }
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                          background: data.salesRepEmail ? "#fff" : "#fafafa",
                        }}
                      />
                      {data.salesRepId && !data.salesRepEmail ? (
                        <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          ⚠️ No email on file for this rep — type it once and it will be saved
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Card>

                {/* Claim Stage selector */}
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Claim Stage</SectionTitle>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <button
                      type="button"
                      onClick={() => update("claimStage", "pre_inspection")}
                      style={{
                        padding: "16px 12px",
                        borderRadius: 16,
                        border: data.claimStage === "pre_inspection" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                        background: data.claimStage === "pre_inspection" ? "#f0fdf4" : "#fff",
                        cursor: "pointer",
                        textAlign: "center",
                        transition: "all 0.2s",
                      }}
                    >
                      <div style={{ fontSize: 28, marginBottom: 6 }}>🏠</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        Roof Needs Inspection
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Signing before the inspection — next step is scheduling
                      </div>
                      {data.claimStage === "pre_inspection" ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </button>

                    <button
                      type="button"
                      onClick={() => update("claimStage", "post_inspection")}
                      style={{
                        padding: "16px 12px",
                        borderRadius: 16,
                        border: data.claimStage === "post_inspection" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                        background: data.claimStage === "post_inspection" ? "#f0fdf4" : "#fff",
                        cursor: "pointer",
                        textAlign: "center",
                        transition: "all 0.2s",
                      }}
                    >
                      <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        Roof Was Inspected
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Damage confirmed — filing the claim now
                      </div>
                      {data.claimStage === "post_inspection" ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </button>
                  </div>
                </Card>
              </div>

              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  Signing option
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 12,
                  }}
                >
                  <Button
                    variant={signMode === "now" ? "default" : "outline"}
                    onClick={() => setSignMode("now")}
                  >
                    <FileSignature size={16} /> Sign Now
                  </Button>

                  <Button
                    variant={signMode === "send" ? "default" : "outline"}
                    onClick={() => setSignMode("send")}
                  >
                    <Send size={16} /> Send for Signing
                  </Button>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                <Separator />
              </div>

              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  Choose form{selectedDocs.length !== 1 ? "s" : ""}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>

                  {/* Free Roof Inspection — U.S. Shingle branding */}
                  <button type="button" onClick={() => toggleDocSelection("insp")}
                    style={{
                      padding: 0, borderRadius: 16, textAlign: "left", cursor: "pointer",
                      border: selectedDocs.includes("insp") ? "3px solid #1a2e5a" : "2px solid #d1d5db",
                      background: "#fff",
                      boxShadow: selectedDocs.includes("insp") ? "0 4px 16px rgba(26,46,90,0.25)" : "0 2px 6px rgba(0,0,0,0.06)",
                      transition: "all 0.15s",
                      overflow: "hidden",
                    }}>
                    {/* Top third — Navy */}
                    <div style={{ background: "#1a2e5a", padding: "10px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.5)", flexShrink: 0 }} />
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.8)", flexShrink: 0 }} />
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "#fff", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                          U.S. Shingle & Metal
                        </span>
                      </div>
                    </div>
                    {/* Middle third — White */}
                    <div style={{ background: "#fff", padding: "10px 14px" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>
                        🏠 Free Roof Inspection
                      </div>
                      {selectedDocs.includes("insp") ? (
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>✓ Selected</div>
                      ) : null}
                    </div>
                    {/* Bottom third — Red */}
                    <div style={{ background: "#c8392b", padding: "8px 14px" }}>
                      <div style={{ fontSize: 12, color: "#fff", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.3 }}>
                        Homeowner signs inspection agreement
                      </div>
                    </div>
                  </button>

                  {/* Letter of Representation — CCG branding */}
                  <button type="button" onClick={() => toggleDocSelection("lor")}
                    style={{
                      padding: "16px 14px", borderRadius: 16, textAlign: "left", cursor: "pointer",
                      border: "none",
                      background: selectedDocs.includes("lor")
                        ? "linear-gradient(135deg, #199c2e 0%, #14752a 100%)"
                        : "linear-gradient(135deg, #22b535 0%, #199c2e 100%)",
                      boxShadow: selectedDocs.includes("lor") ? "0 4px 16px rgba(25,156,46,0.35)" : "0 2px 8px rgba(25,156,46,0.18)",
                      transition: "all 0.15s",
                      opacity: selectedDocs.includes("lor") ? 1 : 0.82,
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.7)", flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                        Capital Claims Group
                      </span>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", marginBottom: 2 }}>
                      📋 Letter of Representation
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                      Authorizes CCG to represent the client
                    </div>
                    {selectedDocs.includes("lor") ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#fff", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>

                  {/* PA Authorization — CCG branding */}
                  <button type="button" onClick={() => toggleDocSelection("pac")}
                    style={{
                      padding: "16px 14px", borderRadius: 16, textAlign: "left", cursor: "pointer",
                      border: "none",
                      background: selectedDocs.includes("pac")
                        ? "linear-gradient(135deg, #14752a 0%, #199c2e 100%)"
                        : "linear-gradient(135deg, #199c2e 0%, #22b535 100%)",
                      boxShadow: selectedDocs.includes("pac") ? "0 4px 16px rgba(25,156,46,0.35)" : "0 2px 8px rgba(25,156,46,0.18)",
                      transition: "all 0.15s",
                      opacity: selectedDocs.includes("pac") ? 1 : 0.82,
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.7)", flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                        Capital Claims Group
                      </span>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", marginBottom: 2 }}>
                      📄 PA Authorization
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                      Public Adjuster Contract
                    </div>
                    {selectedDocs.includes("pac") ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#fff", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>
                </div>

                {selectedDocs.includes("insp") && (selectedDocs.includes("lor") || selectedDocs.includes("pac")) ? (
                  <div style={{ marginTop: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#1e40af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                    ℹ️ Inspection form first, then PA paperwork — the app will guide you through both in order.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 10 }}>
                    Select one or more forms to include in this signing session.
                  </div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <Button onClick={beginDocumentFlow} disabled={!selectedDocs.length}>
                  {signMode === "send"
                    ? "Continue to Send for Signing"
                    : "Continue to Sign"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {view === "review" ? (
          <>
            {!isSigningFromLink ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => setView("input")}
                >
                  <ArrowLeft size={16} /> Back
                </Button>
              </div>
            ) : null}

            {/* ── Hero welcome banner ── */}
            <div
              style={{
                background: "linear-gradient(135deg, #199c2e 0%, #14752200 100%), #199c2e",
                borderRadius: 24,
                padding: "36px 32px 32px",
                color: "#fff",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {/* decorative circle */}
              <div style={{ position: "absolute", top: -40, right: -40, width: 180, height: 180, background: "rgba(255,255,255,0.07)", borderRadius: "50%" }} />
              <div style={{ position: "absolute", bottom: -20, right: 60, width: 100, height: 100, background: "rgba(255,255,255,0.05)", borderRadius: "50%" }} />

              <div style={{ fontSize: 44, marginBottom: 10 }}>👋</div>
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  fontFamily: "'Oswald', sans-serif",
                  lineHeight: 1.15,
                  marginBottom: 14,
                  letterSpacing: "0.01em",
                }}
              >
                You're Almost Done!
              </div>
              <div
                style={{
                  fontSize: 21,
                  lineHeight: 1.7,
                  opacity: 0.95,
                  maxWidth: 580,
                  fontFamily: "'Nunito', sans-serif",
                  fontWeight: 600,
                }}
              >
                {reviewHeadline}
              </div>
            </div>

            {/* ── Step indicator ── */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "0 4px",
              }}
            >
              {[
                { n: "1", label: "Review Docs" },
                { n: "2", label: "Authorize" },
                { n: "3", label: "Sign & Done!" },
              ].map((step, i) => (
                <React.Fragment key={step.n}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        background: i === 0 ? "#199c2e" : i === 1 ? (reviewReady ? "#199c2e" : "#e5e7eb") : (reviewReady ? "#199c2e" : "#e5e7eb"),
                        color: i === 0 ? "#fff" : (reviewReady ? "#fff" : "#9ca3af"),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 15,
                        fontFamily: "'Oswald', sans-serif",
                        transition: "background 0.4s",
                      }}
                    >
                      {step.n}
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                      {step.label}
                    </div>
                  </div>
                  {i < 2 ? (
                    <div style={{ flex: 1, height: 3, background: reviewReady && i === 0 ? "#199c2e" : "#e5e7eb", margin: "0 4px", marginBottom: 20, transition: "background 0.4s" }} />
                  ) : null}
                </React.Fragment>
              ))}
            </div>

            {/* ── Document cards ── */}
            <div style={{ display: "grid", gap: 20 }}>

              {selectedDocs.includes("insp") ? (
                <div style={{
                  borderRadius: 24,
                  border: inspAgreed ? "3px solid #1a2e5a" : "2px solid #e5e7eb",
                  background: inspAgreed ? "#eef1f8" : "#fff",
                  padding: "0",
                  transition: "border-color 0.3s, background 0.3s",
                  boxShadow: inspAgreed ? "0 0 0 4px rgba(26,46,90,0.08)" : "0 1px 3px rgba(0,0,0,0.06)",
                  overflow: "hidden",
                }}>
                  {/* USS tricolor stripe */}
                  <div style={{ display: "flex", height: 6 }}>
                    <div style={{ flex: 1, background: "#1a2e5a" }} />
                    <div style={{ flex: 1, background: "#e5e7eb" }} />
                    <div style={{ flex: 1, background: "#c8392b" }} />
                  </div>
                  <div style={{ padding: "24px 28px 20px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                      <div style={{
                        width: 52, height: 52, borderRadius: 16,
                        background: inspAgreed ? "#1a2e5a" : "#f3f4f6",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 24, flexShrink: 0, transition: "background 0.3s",
                      }}>
                        {inspAgreed ? "✅" : "🏠"}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                          U.S. Shingle & Metal LLC — Document 1 of {selectedDocs.length}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", lineHeight: 1.2 }}>
                          Free Roof Inspection Agreement
                        </div>
                      </div>
                    </div>
                    <p style={{ fontSize: 14, color: "#374151", fontFamily: "'Nunito', sans-serif", lineHeight: 1.6, margin: "0 0 20px" }}>
                      This authorizes U.S. Shingle & Metal LLC to perform a free roof inspection at your property and share findings with a Public Adjuster for review.
                    </p>
                    {!inspAgreed ? (
                      <div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 10 }}>
                          <button type="button"
                            onClick={async () => {
                              try {
                                const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
                                const blobUrl = URL.createObjectURL(blob);
                                window.open(blobUrl, "_blank");
                                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                              } catch(err) { alert(err?.message || "Failed to preview."); }
                            }}
                            style={{
                              padding: "12px 8px", borderRadius: 12,
                              border: "2px solid #1a2e5a", background: "#fff",
                              color: "#1a2e5a", fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700, fontSize: 13, cursor: "pointer",
                              letterSpacing: "0.04em", textTransform: "uppercase",
                            }}>
                            👁 Preview
                          </button>
                          <button type="button" onClick={() => setInspAgreed(true)}
                          style={{
                            width: "100%", padding: 0, borderRadius: 16, border: "none",
                            background: "transparent", cursor: "pointer",
                            overflow: "hidden", display: "flex", flexDirection: "column",
                            animation: "ccg-pulse 2s infinite",
                          }}>
                          <div style={{ background: "#c8392b", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", letterSpacing: "0.04em", textTransform: "uppercase" }}>👍 Tap Here</span>
                          </div>
                          <div style={{ background: "#fff", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#1a2e5a", letterSpacing: "0.04em", textTransform: "uppercase" }}>Looks Good!</span>
                          </div>
                          <div style={{ background: "#1a2e5a", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", letterSpacing: "0.04em", textTransform: "uppercase" }}>✅ Authorized</span>
                          </div>
                        </button>
                        </div>
                        <div style={{ textAlign: "center", marginTop: 10, fontSize: 13, color: "#1a2e5a", fontWeight: 600, fontFamily: "'Nunito', sans-serif" }}>
                          ☝️ Please tap the button above to continue
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "#1a2e5a", borderRadius: 14, padding: "14px 20px", textAlign: "center" }}>
                        <span style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em" }}>
                          ✅ Authorized!
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {selectedDocs.includes("lor") ? (
                <div
                  style={{
                    borderRadius: 24,
                    border: lorAgreed ? "2px solid #199c2e" : "2px solid #e5e7eb",
                    background: lorAgreed ? "#f0fdf4" : "#fff",
                    padding: "28px 28px 24px",
                    transition: "border-color 0.3s, background 0.3s",
                    boxShadow: lorAgreed ? "0 0 0 4px rgba(25,156,46,0.08)" : "0 1px 3px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 16,
                        background: lorAgreed ? "#199c2e" : "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 24,
                        flexShrink: 0,
                        transition: "background 0.3s",
                      }}
                    >
                      {lorAgreed ? "✅" : "📄"}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#199c2e",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontFamily: "'Oswald', sans-serif",
                          marginBottom: 4,
                        }}
                      >
                        Document 1 of {selectedDocs.length}
                      </div>
                      <div
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          color: "#111827",
                          fontFamily: "'Oswald', sans-serif",
                          lineHeight: 1.15,
                        }}
                      >
                        Letter of Representation
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 19,
                      lineHeight: 1.75,
                      color: "#374151",
                      marginBottom: 24,
                      paddingLeft: 68,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 500,
                    }}
                  >
                    {reviewLorText}
                  </div>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingLeft: 68 }}>
                    <button
                      type="button"
                      onClick={() => previewDocument("lor")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 18px",
                        borderRadius: 12,
                        border: "1.5px solid #d1d5db",
                        background: "#fff",
                        color: "#374151",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 600,
                        fontSize: 14,
                        letterSpacing: "0.03em",
                        cursor: "pointer",
                        textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>

                    <button
                      type="button"
                      onClick={() => setLorAgreed(true)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: lorAgreed ? "12px 28px" : "14px 32px",
                        borderRadius: 16,
                        border: lorAgreed ? "2px solid #15803d" : "3px solid #15803d",
                        background: lorAgreed ? "#f0fdf4" : "#199c2e",
                        color: lorAgreed ? "#15803d" : "#fff",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: lorAgreed ? 16 : 18,
                        letterSpacing: "0.04em",
                        cursor: lorAgreed ? "default" : "pointer",
                        textTransform: "uppercase",
                        transition: "all 0.3s",
                        boxShadow: lorAgreed ? "none" : "0 6px 20px rgba(25,156,46,0.45)",
                        animation: lorAgreed ? "none" : "ccg-pulse 2s ease-in-out infinite",
                      }}
                    >
                      {lorAgreed ? "✅ Authorized!" : "👍 Tap Here — Looks Good!"}
                    </button>
                  </div>
                  {!lorAgreed ? (
                    <div style={{
                      marginTop: 10,
                      paddingLeft: 68,
                      fontSize: 13,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 700,
                      color: "#199c2e",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      animation: "ccg-bounce 1.2s ease-in-out infinite",
                    }}>
                      ☝️ Please tap the green button above to continue
                    </div>
                  ) : null}
                </div>
              ) : null}

              {selectedDocs.includes("pac") ? (
                <div
                  style={{
                    borderRadius: 24,
                    border: pacAgreed ? "2px solid #199c2e" : "2px solid #e5e7eb",
                    background: pacAgreed ? "#f0fdf4" : "#fff",
                    padding: "28px 28px 24px",
                    transition: "border-color 0.3s, background 0.3s",
                    boxShadow: pacAgreed ? "0 0 0 4px rgba(25,156,46,0.08)" : "0 1px 3px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 16,
                        background: pacAgreed ? "#199c2e" : "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 24,
                        flexShrink: 0,
                        transition: "background 0.3s",
                      }}
                    >
                      {pacAgreed ? "✅" : "📋"}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#199c2e",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontFamily: "'Oswald', sans-serif",
                          marginBottom: 4,
                        }}
                      >
                        Document {selectedDocs.includes("lor") ? "2" : "1"} of {selectedDocs.length}
                      </div>
                      <div
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          color: "#111827",
                          fontFamily: "'Oswald', sans-serif",
                          lineHeight: 1.15,
                        }}
                      >
                        Public Adjuster Authorization
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 19,
                      lineHeight: 1.75,
                      color: "#374151",
                      marginBottom: 24,
                      paddingLeft: 68,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 500,
                    }}
                  >
                    {reviewPacText}
                  </div>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingLeft: 68 }}>
                    <button
                      type="button"
                      onClick={() => previewDocument("pac")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 18px",
                        borderRadius: 12,
                        border: "1.5px solid #d1d5db",
                        background: "#fff",
                        color: "#374151",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 600,
                        fontSize: 14,
                        letterSpacing: "0.03em",
                        cursor: "pointer",
                        textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>

                    <button
                      type="button"
                      onClick={() => setPacAgreed(true)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: pacAgreed ? "12px 28px" : "14px 32px",
                        borderRadius: 16,
                        border: pacAgreed ? "2px solid #15803d" : "3px solid #15803d",
                        background: pacAgreed ? "#f0fdf4" : "#199c2e",
                        color: pacAgreed ? "#15803d" : "#fff",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: pacAgreed ? 16 : 18,
                        letterSpacing: "0.04em",
                        cursor: pacAgreed ? "default" : "pointer",
                        textTransform: "uppercase",
                        transition: "all 0.3s",
                        boxShadow: pacAgreed ? "none" : "0 6px 20px rgba(25,156,46,0.45)",
                        animation: pacAgreed ? "none" : "ccg-pulse 2s ease-in-out infinite",
                      }}
                    >
                      {pacAgreed ? "✅ Authorized!" : "👍 Tap Here — Looks Good!"}
                    </button>
                  </div>
                  {!pacAgreed ? (
                    <div style={{
                      marginTop: 10,
                      paddingLeft: 68,
                      fontSize: 13,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 700,
                      color: "#199c2e",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}>
                      ☝️ Please tap the green button above to continue
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* ── Help text ── */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 20px",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 14,
                fontSize: 15,
                color: "#92400e",
              }}
            >
              <span style={{ fontSize: 20 }}>💡</span>
              <span style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 600, fontSize: 16 }}>{reviewHelpText}</span>
            </div>

            <div id="signature-section" style={{ scrollMarginTop: 20 }}>
              {renderSigningFields(pendingSend)}
            </div>

            <div
              style={{
                position: "absolute",
                left: "-20000px",
                top: 0,
                width: 1100,
                pointerEvents: "none",
              }}
            >
              {selectedDocs.includes("lor") ? (
                <LetterOfRepresentation
                  data={data}
                  sig1={effectiveSig1}
                  sig2={effectiveSig2}
                  auditInfo={auditInfo}
                  claimId={currentClaimId}
                  isExportingPdf={isExportingPdf}
                />
              ) : null}

              {selectedDocs.includes("pac") ? (
                <PublicAdjusterContract
                  data={{
                    ...data,
                    initials1: effectiveInitials1,
                    initials2: effectiveInitials2,
                  }}
                  sig1={effectiveSig1}
                  sig2={effectiveSig2}
                  auditInfo={auditInfo}
                  claimId={currentClaimId}
                  isExportingPdf={isExportingPdf}
                />
              ) : null}
            </div>
          </>
        ) : null}

        {view === "sign" ? (
          <>
            {!isSigningFromLink ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => setView("input")}
                >
                  <ArrowLeft size={16} /> Back
                </Button>
              </div>
            ) : null}

            <Card>
              <CardContent>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#111827",
                    marginBottom: 10,
                  }}
                >
                  Forms included in this signing session
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {selectedDocs.map((doc) => (
                    <div
                      key={doc}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 999,
                        background: "#eef2ff",
                        border: "1px solid #c7d2fe",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#3730a3",
                      }}
                    >
                      {documentLabel(doc)}
                    </div>
                  ))}
                </div>

                {selectedDocs.length > 1 ? (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 13,
                      color: "#6b7280",
                    }}
                  >
                    Review both documents below. Your signatures and initials
                    will apply to all selected forms.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {selectedDocs.includes("lor") ? (
              <LetterOfRepresentation
                data={data}
                sig1={effectiveSig1}
                sig2={effectiveSig2}
                auditInfo={auditInfo}
                claimId={currentClaimId}
                isExportingPdf={isExportingPdf}
              />
            ) : null}

            {selectedDocs.includes("pac") ? (
              <PublicAdjusterContract
                data={{
                  ...data,
                  initials1: effectiveInitials1,
                  initials2: effectiveInitials2,
                }}
                sig1={effectiveSig1}
                sig2={effectiveSig2}
                auditInfo={auditInfo}
                claimId={currentClaimId}
                isExportingPdf={isExportingPdf}
              />
            ) : null}

            <div id="signature-section" style={{ scrollMarginTop: 20 }}>
              {renderSigningFields(pendingSend)}
            </div>
          </>
        ) : null}
        {/* ── DUPLICATE VIEW ── */}
        {view === "duplicate" && duplicateRecord ? (
          <DuplicateScreen
            duplicateRecord={duplicateRecord}
            signMode={signMode}
            signerEmail={data.signerEmail}
            onGoBack={() => { setDuplicateRecord(null); setView("input"); }}
            onProceedAnyway={() => {
              setDuplicateRecord(null);
              setPendingSend(signMode === "send");
              setCurrentClaimId(null);
              setAuditInfo(initialAuditInfo);
              setSig1(""); setSig2(""); setTypedSig1(""); setTypedSig2("");
              setSigMethod1("draw"); setSigMethod2("draw");
              setInitialsMethod1("draw"); setInitialsMethod2("draw");
              setData(prev => ({ ...prev, initials1: "", initials2: "" }));
              setInitials1Typed(""); setInitials2Typed("");
              setLorAgreed(false); setPacAgreed(false); setInspAgreed(false);
              setSubmitAttempted(false); setInspSig(""); setInspTypedSig("");
              setInspSubmitAttempted(false); setInspectionOnly(false);
              window.scrollTo({ top: 0, behavior: "smooth" });
              if (signMode === "send") setView("sending");
              else setView("review");
            }}
            onResend={async () => {
              const rec = duplicateRecord.record;
              if (duplicateRecord.type === "claim" && rec.id) setCurrentClaimId(rec.id);
              setDuplicateRecord(null);
              setPendingSend(true);
              setView("sending");
            }}
          />
        ) : null}

        {/* ── SENDING VIEW — auto-submits when entered ── */}
        {view === "sending" ? (
          <SendingScreen onMount={async () => {
            setIsSubmitting(true);
            try { await submitDoc(); }
            catch(e) { alert(e?.message || "Something went wrong."); setView("input"); setIsSubmitting(false); }
          }} />
        ) : null}

        {/* ── SENT VIEW — confirmation after send-for-signing ── */}
        {view === "sent" ? (
          <div style={{ maxWidth: 540, margin: "0 auto", padding: "48px 20px" }}>
            <div style={{
              background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
              borderRadius: 24, padding: "40px 32px", textAlign: "center", color: "#fff", marginBottom: 24,
            }}>
              <div style={{ fontSize: 64, marginBottom: 12 }}>📨</div>
              <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 10 }}>
                Sent for Signing!
              </div>
              <div style={{ fontSize: 16, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
                The signing link has been emailed to<br/>
                <strong>{data.signerEmail}</strong>
              </div>
            </div>
            <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "24px 26px", marginBottom: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>
                What happens next:
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📧</span><span>Homeowner receives an email with a secure signing link</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>✍️</span><span>They review and sign at their own pace</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📋</span><span>Once signed, you and the PA will be notified automatically</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📄</span><span>Signed PDFs emailed to everyone — no follow-up needed</span>
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <button type="button" onClick={() => { setView("input"); setSignMode("now"); }}
                style={{ padding: "14px", borderRadius: 14, border: "2px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                ✚ New Intake
              </button>
              <button type="button" onClick={() => { setView("input"); setSignMode("send"); }}
                style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                📨 Send Another
              </button>
            </div>
          </div>
        ) : null}

        {/* ── THANK YOU VIEW ── */}
        {view === "thankyou" ? (
          <>
          <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 16px" }}>

            {/* ── SIGN NOW: Rep confirmation screen ── */}
            {!isSigningFromLink && !inspectionOnly ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
                  borderRadius: 28, padding: "40px 36px", textAlign: "center",
                  marginBottom: 24, color: "#fff",
                }}>
                  <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
                  <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 12 }}>
                    Documents Signed!
                  </div>
                  <div style={{ fontSize: 18, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.93, lineHeight: 1.6 }}>
                    {[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")} has signed and copies have been emailed to everyone.
                  </div>
                </div>
                <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "24px 28px", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>Summary</div>
                  <div style={{ display: "grid", gap: 8, fontSize: 14, fontFamily: "'Nunito', sans-serif" }}>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Homeowner:</span>
                      <span style={{ fontWeight: 700 }}>{[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Address:</span>
                      <span style={{ fontWeight: 600 }}>{[data.address, data.city, data.state].filter(Boolean).join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Rep:</span>
                      <span style={{ fontWeight: 600 }}>{data.salesRepName || "—"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Docs:</span>
                      <span style={{ fontWeight: 600 }}>{selectedDocs.map(d => documentLabel(d)).join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Email:</span>
                      <span style={{ fontWeight: 600 }}>{data.signerEmail}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <button type="button" onClick={() => { setView("input"); setData(prev => ({ ...prev, homeowner1: "", homeowner2: "", phone: "", signerEmail: "", address: "", city: "", state: "", zip: "" })); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "2px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ✚ New Client
                  </button>
                  <button type="button" onClick={() => { setView("input"); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ← Back to Intake
                  </button>
                </div>
              </>
            ) : null}

            {/* ── INSPECTION ONLY: USS Welcome screen ── */}
            {inspectionOnly ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #1a2e5a 0%, #0f1e3d 100%)",
                  borderRadius: 28, padding: "40px 36px", textAlign: "center",
                  marginBottom: 24, color: "#fff",
                }}>
                  <div style={{ fontSize: 56, marginBottom: 16 }}>🏠</div>
                  <div style={{ fontSize: 32, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 12 }}>
                    {activeTYHeadline}
                  </div>
                  <div style={{ fontSize: 17, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
                    {activeTYOpening}
                  </div>
                </div>
                <div style={{ background: "#fff", borderRadius: 24, border: "1px solid #e5e7eb", padding: "28px 28px 24px", marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#1a2e5a", fontFamily: "'Oswald', sans-serif", marginBottom: 16 }}>
                    📋 {activeTYHeadline === inspOnlyHeadline ? "What Happens Next" : "Next Steps"}
                  </div>
                  <div style={{ display: "grid", gap: 12 }}>
                    {activeTYSteps.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "12px 16px", background: "#eef1f8", borderRadius: 14, border: "1px solid #bfdbfe" }}>
                        <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#1a2e5a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ fontSize: 15, color: "#1e3a5f", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.5 }}>{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 20, padding: "18px 24px", textAlign: "center", marginBottom: 24 }}>
                  <div style={{ fontSize: 16, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 700, lineHeight: 1.6 }}>{activeTYClosing}</div>
                </div>
                <div style={{ background: "#1a2e5a", borderRadius: 20, padding: "20px 24px", color: "#fff", marginBottom: 24, textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>📞 Contact U.S. Shingle & Metal LLC</div>
                  <div style={{ fontSize: 14, fontFamily: "'Nunito', sans-serif", lineHeight: 1.8, opacity: 0.9 }}>
                    {ussContactPhone} &nbsp;|&nbsp; {ussContactEmail}
                  </div>
                </div>
              </>
            ) : null}

            {/* ── EMAIL LINK: Full homeowner welcome screen ── */}
            {isSigningFromLink && !inspectionOnly ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
                  borderRadius: 28, padding: "40px 36px 36px", textAlign: "center",
                  marginBottom: 28, position: "relative", overflow: "hidden",
                }}>
                  <div style={{ position: "absolute", top: -30, right: -30, width: 140, height: 140, background: "rgba(255,255,255,0.06)", borderRadius: "50%" }} />
                  <div style={{ fontSize: 72, marginBottom: 16, lineHeight: 1 }}>🎉</div>
                  <div style={{ fontSize: 36, fontWeight: 700, color: "#fff", fontFamily: "'Oswald', sans-serif", lineHeight: 1.1, marginBottom: 16 }}>
                    {activeTYHeadline}
                  </div>
                  <div style={{ fontSize: 18, color: "rgba(255,255,255,0.92)", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.65, maxWidth: 480, margin: "0 auto" }}>
                    {activeTYOpening}
                  </div>
                </div>
                <div style={{ background: "#fff", borderRadius: 24, border: "1px solid #e5e7eb", padding: "28px 28px 24px", marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 24 }}>📋</span> What Happens Next
                  </div>
                  <div style={{ display: "grid", gap: 14 }}>
                    {activeTYSteps.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 16px", background: "#f0fdf4", borderRadius: 16, border: "1px solid #bbf7d0" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif", flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ fontSize: 16, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.55 }}>{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 20, padding: "20px 24px", textAlign: "center", marginBottom: 32 }}>
                  <div style={{ fontSize: 17, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 700, lineHeight: 1.6 }}>{activeTYClosing}</div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 20, padding: "22px 26px", marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <span style={{ fontSize: 36, flexShrink: 0 }}>📧</span>
                    <div>
                      <div style={{ fontSize: 19, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>Check Your Email!</div>
                      <div style={{ fontSize: 15, color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.65 }}>
                        We sent your signed documents and a Welcome Package to <strong>{data.signerEmail}</strong>.
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <img src="/pa-header.png" alt="Capital Claims Group" style={{ maxWidth: 260, opacity: 0.85 }} />
                </div>
              </>
            ) : null}

          </div>
          </>
        ) : null}

        {/* ── INSPECTION FORM VIEW ── */}
        {view === "inspection" ? (
          <>
            <div>
              <Button variant="outline" onClick={() => setView("input")}>
                <ArrowLeft size={16} /> Back
              </Button>
            </div>

            {/* Hero banner */}
            <div style={{
              background: "linear-gradient(135deg, #1a2e5a 0%, #0f1e3d 100%)",
              borderRadius: 24,
              padding: "32px 28px",
              color: "#fff",
              position: "relative",
              overflow: "hidden",
            }}>
              <div style={{ position: "absolute", top: -30, right: -30, width: 160, height: 160, background: "rgba(200,57,43,0.15)", borderRadius: "50%" }} />
              <div style={{ position: "absolute", bottom: -20, left: 40, width: 100, height: 100, background: "rgba(200,57,43,0.1)", borderRadius: "50%" }} />
              <div style={{ fontSize: 36, marginBottom: 8 }}>🏠</div>
              <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>
                Free Roof Inspection Agreement
              </div>
              <div style={{ fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, color: "#c8392b", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                U.S. Shingle & Metal LLC
              </div>
              <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.88 }}>
                Fill in the homeowner details and collect their signature below.
              </div>
            </div>

            {/* Form fields */}
            <Card>
              <CardContent>
                <div style={{ display: "grid", gap: 20 }}>
                  <SectionTitle>Client Information</SectionTitle>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                    <div>
                      <Label>Date</Label>
                      <input type="date" value={inspData.date} onChange={e => updateInsp("date", e.target.value)}
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Client Full Name *</Label>
                      <input type="text" value={inspData.clientName} onChange={e => updateInsp("clientName", e.target.value)}
                        placeholder="Full name"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: inspSubmitAttempted && !inspData.clientName ? "2px solid #ef4444" : "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Mobile</Label>
                      <input type="tel" value={inspData.mobile}
                        onChange={e => {
                          const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                          let fmt = digits;
                          if (digits.length >= 7) fmt = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
                          else if (digits.length >= 4) fmt = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
                          else if (digits.length >= 1) fmt = `(${digits}`;
                          updateInsp("mobile", fmt);
                        }}
                        placeholder="(727) 000-0000"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Email</Label>
                      <input type="email" value={inspData.email} onChange={e => updateInsp("email", e.target.value)}
                        placeholder="client@email.com"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Address *</Label>
                      <input type="text" value={inspData.address} onChange={e => updateInsp("address", e.target.value)}
                        placeholder="Street address"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: inspSubmitAttempted && !inspData.address ? "2px solid #ef4444" : "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>City</Label>
                      <input type="text" value={inspData.city} onChange={e => updateInsp("city", e.target.value)}
                        placeholder="City"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>State</Label>
                      <input type="text" value={inspData.state} onChange={e => updateInsp("state", e.target.value)}
                        placeholder="FL"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Zip</Label>
                      <input type="text" value={inspData.zip} onChange={e => updateInsp("zip", e.target.value)}
                        placeholder="33782"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Signature section */}
            <div>
              {!effectiveInspSig ? (
                <div style={{
                  background: "linear-gradient(135deg, #1a2e5a 0%, #0f1e3d 100%)",
                  borderRadius: "24px 24px 0 0",
                  padding: "24px 28px 20px",
                  color: "#fff",
                }}>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>✍️</div>
                  <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>
                    Client Signature
                  </div>
                  <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92 }}>
                    Use your finger, mouse, or type your name below.
                  </div>
                </div>
              ) : null}

              <Card style={{ borderRadius: effectiveInspSig ? 24 : "0 0 24px 24px", borderTop: effectiveInspSig ? undefined : "none" }}>
                <CardContent>
                  {/* Method selector */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                    {[["draw", "👆", "Draw It"], ["type", "⌨️", "Type It"]].map(([m, emoji, label]) => (
                      <button key={m} type="button" onClick={() => setInspSigMethod(m)}
                        style={{
                          padding: "14px 12px", borderRadius: 16, textAlign: "center",
                          border: inspSigMethod === m ? "3px solid #1a2e5a" : "2px solid #e5e7eb",
                          background: inspSigMethod === m ? "#eef1f8" : "#fff", cursor: "pointer",
                        }}>
                        <div style={{ fontSize: 28, marginBottom: 6 }}>{emoji}</div>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Nunito', sans-serif", color: "#111827" }}>{label}</div>
                        {inspSigMethod === m ? <div style={{ fontSize: 12, color: "#1a2e5a", fontWeight: 700, fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>✓ Selected</div> : null}
                      </button>
                    ))}
                  </div>

                  {inspSigMethod === "draw" ? (
                    <SignaturePad title="" value={inspSig} onChange={setInspSig} required missing={inspSubmitAttempted && !effectiveInspSig} />
                  ) : (
                    <TypedSignatureField title="" value={inspTypedSig} onChange={setInspTypedSig}
                      fontValue={inspSigFont} onFontChange={setInspSigFont}
                      required missing={inspSubmitAttempted && !effectiveInspSig}
                      placeholder="Type full legal name" />
                  )}

                  {inspSubmitAttempted && !inspData.clientName ? (
                    <div style={{ color: "#ef4444", fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginBottom: 12 }}>
                      ⚠️ Please enter the client name above
                    </div>
                  ) : null}
                  {inspSubmitAttempted && !inspData.address ? (
                    <div style={{ color: "#ef4444", fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginBottom: 12 }}>
                      ⚠️ Please enter the property address above
                    </div>
                  ) : null}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
                          const blobUrl = URL.createObjectURL(blob);
                          window.open(blobUrl, "_blank");
                          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                        } catch(err) {
                          alert(err?.message || "Failed to preview.");
                        }
                      }}
                      style={{
                        padding: "12px 16px", borderRadius: 14,
                        border: "2px solid #1a2e5a", background: "#fff",
                        color: "#1a2e5a", fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700, fontSize: 14, cursor: "pointer",
                        letterSpacing: "0.04em", textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>
                    <Button onClick={submitInspection} disabled={inspSubmitting}
                      style={{ background: "#1a2e5a", border: "1px solid #1a2e5a" }}>
                      <Mail size={16} /> {inspSubmitting ? "Submitting..." : "Submit & Email to Client"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Hidden printable PDF — moved to always-rendered section below */}
            <div style={{ display: "none" }}>
              <div id="inspection-printable-placeholder" style={{ fontFamily: "Arial, Helvetica, sans-serif", background: "#fff", width: "8.5in", padding: "0.6in 0.7in", boxSizing: "border-box" }}>
                {/* Header */}
                <div style={{ textAlign: "center", marginBottom: 24 }}>

                  <div style={{ fontSize: 20, fontWeight: 700, color: "#1a2e5a", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1.5 }}>
                    Free Roof Inspection Agreement
                  </div>
                  <div style={{ width: 60, height: 3, background: "#c8392b", margin: "0 auto 10px", borderRadius: 2 }} />
                  <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }}>
                    {INSPECTION_COMPANY.name} &nbsp;|&nbsp; {INSPECTION_COMPANY.address}<br />
                    Phone: {INSPECTION_COMPANY.phone} &nbsp;|&nbsp; Email: {INSPECTION_COMPANY.email} &nbsp;|&nbsp; License #: {INSPECTION_COMPANY.license}
                  </div>
                  <div style={{ borderBottom: "2px solid #1a2e5a", marginTop: 14 }} />
                </div>

                {/* Client info */}
                <div style={{ display: "grid", gap: 6, fontSize: 14, marginBottom: 20 }}>
                  <div><strong>Date:</strong> {inspData.date}</div>
                  <div><strong>Client:</strong> {inspData.clientName}</div>
                  <div><strong>Mobile:</strong> {inspData.mobile}</div>
                  <div><strong>Address:</strong> {inspData.address} &nbsp; <strong>City:</strong> {inspData.city} &nbsp; <strong>St:</strong> {inspData.state} &nbsp; <strong>Zip:</strong> {inspData.zip}</div>
                  <div><strong>Email:</strong> {inspData.email}</div>
                </div>

                {/* Agreement text */}
                <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 28, color: "#111827" }}>
                  <p style={{ margin: "0 0 10px" }}>
                    Client agrees to allow {INSPECTION_COMPANY.name} (Company) to perform a free roof inspection at the above address and to forward all pictures and findings to a Public Adjuster for review. The Company maintains all required licenses and insurance and will not perform repairs during the inspection.
                  </p>
                  <p style={{ margin: "0 0 10px" }}>
                    Client understands that they do not need to be present during the inspection; however, Company personnel will knock on the door upon arrival.
                  </p>
                  <p style={{ margin: "0 0 10px" }}>
                    If the Public Adjuster determines that storm damage exists, they may proceed with filing an insurance claim provided the Client has hired them. Client authorizes the Public Adjuster to notify the Company of its findings and to keep the Company updated throughout the claims process.
                  </p>
                  <p style={{ margin: 0 }}>
                    Client acknowledges that the Company is a licensed roofing contractor and cannot discuss policy coverages, insurance requirements, or statutory guidelines. Any such questions should be directed to the Public Adjuster or the Client's homeowner's insurance carrier.
                  </p>
                </div>

                {/* Signatures */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
                  <div>
                    <div style={{ marginBottom: 4, fontSize: 12 }}>Client:</div>
                    <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                      {effectiveInspSig ? (
                        <img src={effectiveInspSig} alt="Client signature" style={{ maxHeight: 44, objectFit: "contain" }} />
                      ) : null}
                    </div>
                    <div style={{ fontSize: 11, color: "#374151" }}>{inspData.clientName}</div>
                    <div style={{ fontSize: 12, marginTop: 8 }}>Date: {inspData.date}</div>
                  </div>
                  <div>
                    <div style={{ marginBottom: 4, fontSize: 12 }}>Representative:</div>
                    <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                      <img src={REP_FIXED.signatureImage} alt="Rep signature" style={{ maxHeight: 44, objectFit: "contain" }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#374151" }}>{data.salesRepName || data.representativeName || REP_FIXED.name}</div>
                    <div style={{ fontSize: 12, marginTop: 8 }}>Date: {inspData.date}</div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* ── MANAGER VIEW ── */}
        {view === "manager" ? (
          <Card>
            <CardHeader>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <CardTitle>Manager Settings</CardTitle>
                <button
                  type="button"
                  onClick={() => {
                    setManagerUnlocked(false);
                    setManagerPinEntry("");
                    setView("input");
                  }}
                  style={{
                    background: "transparent",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    padding: "6px 14px",
                    fontSize: 12,
                    fontFamily: "'Oswald', sans-serif",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    color: "#6b7280",
                    cursor: "pointer",
                    textTransform: "uppercase",
                  }}
                >
                  ← Back
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {!managerUnlocked ? (
                <div style={{ maxWidth: 320 }}>
                  <Label>Enter Manager PIN</Label>
                  <input
                    type="password"
                    value={managerPinEntry}
                    onChange={(e) => setManagerPinEntry(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (managerPinEntry === managerPin) {
                          setManagerUnlocked(true);
                          setManagerPinEntry("");
                        } else {
                          alert("Incorrect PIN.");
                          setManagerPinEntry("");
                        }
                      }
                    }}
                    placeholder="Enter PIN and press Enter"
                    style={{
                      width: "100%",
                      height: 44,
                      borderRadius: 14,
                      border: "1px solid #d1d5db",
                      padding: "0 12px",
                      fontSize: 14,
                      boxSizing: "border-box",
                      marginBottom: 12,
                    }}
                  />
                  <Button
                    onClick={() => {
                      if (managerPinEntry === managerPin) {
                        setManagerUnlocked(true);
                        setManagerPinEntry("");
                      } else {
                        alert("Incorrect PIN.");
                        setManagerPinEntry("");
                      }
                    }}
                  >
                    Unlock
                  </Button>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 10 }}>
                    Default PIN: 1234 — change it below once unlocked.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 28 }}>
                  {/* PIN change */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Security</SectionTitle>
                    <div style={{ display: "grid", gap: 16 }}>
                      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div style={{ maxWidth: 300, flex: 1 }}>
                          <Label>Change Manager PIN</Label>
                          <input
                            type="password"
                            value={managerPin}
                            onChange={(e) => setManagerPin(e.target.value)}
                            placeholder="New PIN"
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                          />
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm("Reset all text to factory defaults?")) {
                                setReviewHeadline(DEFAULTS.reviewHeadline);
                                setReviewLorText(DEFAULTS.reviewLorText);
                                setReviewPacText(DEFAULTS.reviewPacText);
                                setReviewHelpText(DEFAULTS.reviewHelpText);
                                setThankYouHeadline(DEFAULTS.thankYouHeadline);
                                setThankYouOpening(DEFAULTS.thankYouOpening);
                                try { setThankYouSteps(JSON.parse(DEFAULTS.thankYouSteps)); } catch {}
                                setThankYouClosing(DEFAULTS.thankYouClosing);
                                setPreInspHeadline(DEFAULTS.preInspHeadline);
                                setPreInspOpening(DEFAULTS.preInspOpening);
                                try { setPreInspSteps(JSON.parse(DEFAULTS.preInspSteps)); } catch {}
                                setPreInspClosing(DEFAULTS.preInspClosing);
                              }
                            }}
                            style={{ padding: "10px 18px", borderRadius: 12, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer", height: 44 }}
                          >
                            ↺ Reset All Text to Defaults
                          </button>
                        </div>
                      </div>
                      <div>
                        <Label>Activity Notification Email</Label>
                        <input
                          type="email"
                          value={activityEmail}
                          onChange={(e) => setActivityEmail(e.target.value)}
                          placeholder="e.g. manager@company.com"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                        />
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          Every signing (PA docs or inspection) will CC this address with a summary. Leave blank to disable.
                        </div>
                      </div>
                    </div>
                  </Card>

                  {/* Review page text */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Review Page Text</SectionTitle>
                    <div style={{ display: "grid", gap: 16 }}>
                      <div>
                        <Label>Headline (shown above the document cards)</Label>
                        <textarea
                          value={reviewHeadline}
                          onChange={(e) => setReviewHeadline(e.target.value)}
                          rows={2}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>Letter of Representation description</Label>
                        <textarea
                          value={reviewLorText}
                          onChange={(e) => setReviewLorText(e.target.value)}
                          rows={3}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>PA Authorization description</Label>
                        <textarea
                          value={reviewPacText}
                          onChange={(e) => setReviewPacText(e.target.value)}
                          rows={3}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>Help text (shown below the document cards)</Label>
                        <textarea
                          value={reviewHelpText}
                          onChange={(e) => setReviewHelpText(e.target.value)}
                          rows={2}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                    </div>
                  </Card>

                  {/* Thank you page text — tabbed */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Thank You Pages</SectionTitle>
                    <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                      {[
                        { key: "post_inspection", label: "✅ Roof Inspected Flow", emoji: "✅" },
                        { key: "pre_inspection",  label: "🏠 Pre-Inspection Flow", emoji: "🏠" },
                      ].map(tab => (
                        <button
                          key={tab.key}
                          type="button"
                          onClick={() => setManagerTYTab(tab.key)}
                          style={{
                            padding: "8px 16px",
                            borderRadius: 12,
                            border: managerTYTab === tab.key ? "2px solid #199c2e" : "1px solid #d1d5db",
                            background: managerTYTab === tab.key ? "#f0fdf4" : "#fff",
                            color: managerTYTab === tab.key ? "#166534" : "#374151",
                            fontFamily: "'Nunito', sans-serif",
                            fontWeight: 700,
                            fontSize: 13,
                            cursor: "pointer",
                          }}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    {managerTYTab === "post_inspection" ? (
                    <>
                    <div style={{ display: "grid", gap: 20 }}>

                      {/* Headline */}
                      <div>
                        <Label>Headline</Label>
                        <input
                          type="text"
                          value={thankYouHeadline}
                          onChange={(e) => setThankYouHeadline(e.target.value)}
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                        />
                      </div>

                      {/* Opening statement */}
                      <div>
                        <Label>Opening statement (shown in the green hero banner)</Label>
                        <textarea
                          value={thankYouOpening}
                          onChange={(e) => setThankYouOpening(e.target.value)}
                          rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
                        />
                      </div>

                      {/* Steps */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <Label>What to expect next (numbered steps)</Label>
                          <button
                            type="button"
                            onClick={() => setThankYouSteps([...thankYouSteps, "✅ New step — click to edit"])}
                            style={{
                              padding: "6px 14px",
                              borderRadius: 10,
                              border: "1.5px solid #199c2e",
                              background: "#fff",
                              color: "#199c2e",
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: "pointer",
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                            }}
                          >
                            + Add Step
                          </button>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {thankYouSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{
                                width: 28, height: 28, borderRadius: "50%", background: "#199c2e",
                                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                                fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif",
                                flexShrink: 0, marginTop: 8,
                              }}>
                                {i + 1}
                              </div>
                              <textarea
                                value={step}
                                onChange={(e) => {
                                  const next = [...thankYouSteps];
                                  next[i] = e.target.value;
                                  setThankYouSteps(next);
                                }}
                                rows={2}
                                style={{
                                  flex: 1,
                                  borderRadius: 12,
                                  border: "1px solid #d1d5db",
                                  padding: "8px 12px",
                                  fontSize: 14,
                                  boxSizing: "border-box",
                                  resize: "vertical",
                                  fontFamily: "inherit",
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => setThankYouSteps(thankYouSteps.filter((_, idx) => idx !== i))}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "#ef4444",
                                  fontSize: 18,
                                  cursor: "pointer",
                                  padding: "4px 6px",
                                  marginTop: 6,
                                  flexShrink: 0,
                                }}
                                title="Remove step"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Closing statement */}
                      <div>
                        <Label>Closing statement (shown in amber box at bottom)</Label>
                        <textarea
                          value={thankYouClosing}
                          onChange={(e) => setThankYouClosing(e.target.value)}
                          rows={2}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 24, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                      <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Live Preview</div>
                      <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 16, padding: "20px 18px" }}>
                        <div style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>🎉</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#15803d", fontFamily: "'Oswald', sans-serif", marginBottom: 6, textAlign: "center" }}>{thankYouHeadline}</div>
                        <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>{thankYouOpening}</div>
                        {thankYouSteps.map((step, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8, padding: "8px 12px", background: "#fff", borderRadius: 10, border: "1px solid #bbf7d0" }}>
                            <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                            <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.4 }}>{step}</div>
                          </div>
                        ))}
                        <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 10, textAlign: "center", fontSize: 13, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{thankYouClosing}</div>
                      </div>
                    </div>
                    </>
                    ) : (
                    <div style={{ display: "grid", gap: 20 }}>
                      <div>
                        <Label>Headline</Label>
                        <input type="text" value={preInspHeadline} onChange={(e) => setPreInspHeadline(e.target.value)}
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Opening statement (shown in the green hero banner)</Label>
                        <textarea value={preInspOpening} onChange={(e) => setPreInspOpening(e.target.value)} rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <Label>What to expect next (numbered steps)</Label>
                          <button type="button" onClick={() => setPreInspSteps([...preInspSteps, "✅ New step — click to edit"])}
                            style={{ padding: "6px 14px", borderRadius: 10, border: "1.5px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                            + Add Step
                          </button>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {preInspSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif", flexShrink: 0, marginTop: 8 }}>{i + 1}</div>
                              <textarea value={step} onChange={(e) => { const n=[...preInspSteps]; n[i]=e.target.value; setPreInspSteps(n); }} rows={2}
                                style={{ flex: 1, borderRadius: 12, border: "1px solid #d1d5db", padding: "8px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                              <button type="button" onClick={() => setPreInspSteps(preInspSteps.filter((_,idx)=>idx!==i))}
                                style={{ background: "transparent", border: "none", color: "#ef4444", fontSize: 18, cursor: "pointer", padding: "4px 6px", marginTop: 6, flexShrink: 0 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label>Closing statement</Label>
                        <textarea value={preInspClosing} onChange={(e) => setPreInspClosing(e.target.value)} rows={2}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div style={{ marginTop: 4, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                        <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Live Preview</div>
                        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 16, padding: "20px 18px" }}>
                          <div style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>🎉</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#15803d", fontFamily: "'Oswald', sans-serif", marginBottom: 6, textAlign: "center" }}>{preInspHeadline}</div>
                          <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>{preInspOpening}</div>
                          {preInspSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8, padding: "8px 12px", background: "#fff", borderRadius: 10, border: "1px solid #bbf7d0" }}>
                              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                              <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.4 }}>{step}</div>
                            </div>
                          ))}
                          <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 10, textAlign: "center", fontSize: 13, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{preInspClosing}</div>
                        </div>
                      </div>
                    </div>
                    )}
                  </Card>

                  {/* Sales Rep Manager */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Sales Rep Manager</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 16 }}>
                      Add reps here. Their name will appear in the Sales Rep dropdown on the intake form.
                    </div>
                    <div style={{ background: "#eef1f8", border: "1px solid #bfdbfe", borderRadius: 14, padding: "14px 18px", marginBottom: 16 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#1e40af", fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>Import Known Reps</div>
                      <div style={{ fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", marginBottom: 10 }}>Click to import all 24 known reps with their Job Nimbus IDs.</div>
                      <button type="button" onClick={seedRepsFromList} disabled={repSaving}
                        style={{ padding: "8px 18px", borderRadius: 10, border: "none", background: "#1e40af", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        {repSaving ? "Importing..." : "⬇️ Import All 24 Reps"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, marginBottom: 16, alignItems: "flex-end" }}>
                      <div>
                        <Label>Rep Name</Label>
                        <input type="text" value={newRepName} onChange={e => setNewRepName(e.target.value)} placeholder="Full name"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Email (optional)</Label>
                        <input type="email" value={newRepEmail} onChange={e => setNewRepEmail(e.target.value)} placeholder="rep@email.com"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <button type="button" onClick={saveRep} disabled={repSaving || !newRepName.trim()}
                        style={{ height: 44, padding: "0 18px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        + Add Rep
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", fontFamily: "'Nunito', sans-serif" }}>
                          {reps.filter(r => r.active !== false).length} active rep{reps.filter(r => r.active !== false).length !== 1 ? "s" : ""}
                        </div>
                        <button type="button" onClick={() => setShowInactiveReps(v => !v)}
                          style={{ fontSize: 12, color: "#6b7280", background: "none", border: "none", cursor: "pointer", fontFamily: "'Nunito', sans-serif", textDecoration: "underline" }}>
                          {showInactiveReps ? "Hide inactive" : `Show inactive (${reps.filter(r => r.active === false).length})`}
                        </button>
                      </div>
                      {reps.filter(r => showInactiveReps || r.active !== false).map(rep => (
                        <div key={rep.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 12, background: rep.active === false ? "#f9fafb" : "#fff", border: "1px solid #e5e7eb", gap: 10, opacity: rep.active === false ? 0.6 : 1 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>
                              {rep.name}
                              {rep.active === false ? <span style={{ fontSize: 10, background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "2px 6px", fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginLeft: 8 }}>INACTIVE</span> : null}
                            </div>
                            {rep.jobnimbus_id ? <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>JN: {rep.jobnimbus_id}</div> : null}
                          </div>
                          <button type="button" onClick={() => toggleRepActive(rep.id, rep.active !== false)}
                            style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 11, cursor: "pointer", fontFamily: "'Nunito', sans-serif", fontWeight: 700 }}>
                            {rep.active === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      ))}
                      {reps.length === 0 ? (
                        <div style={{ fontSize: 13, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", padding: "12px 0" }}>No reps yet — import or add one above.</div>
                      ) : null}
                    </div>
                  </Card>

                  {/* Weekly Report */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Weekly Report</SectionTitle>
                    <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <Label>From</Label>
                          <input type="date" value={reportStartDate} onChange={e => setReportStartDate(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                        <div>
                          <Label>To</Label>
                          <input type="date" value={reportEndDate} onChange={e => setReportEndDate(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {[
                          { label: "This Week", fn: () => { const t=new Date(); const d=new Date(t); d.setDate(t.getDate()-t.getDay()); setReportStartDate(d.toISOString().split("T")[0]); setReportEndDate(t.toISOString().split("T")[0]); } },
                          { label: "Last Week", fn: () => { const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-t.getDay()-7); const e=new Date(t); e.setDate(t.getDate()-t.getDay()-1); setReportStartDate(s.toISOString().split("T")[0]); setReportEndDate(e.toISOString().split("T")[0]); } },
                          { label: "Last 30 Days", fn: () => { const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-30); setReportStartDate(s.toISOString().split("T")[0]); setReportEndDate(t.toISOString().split("T")[0]); } },
                          { label: "This Month", fn: () => { const t=new Date(); setReportStartDate(new Date(t.getFullYear(),t.getMonth(),1).toISOString().split("T")[0]); setReportEndDate(t.toISOString().split("T")[0]); } },
                        ].map(({ label, fn }) => (
                          <button key={label} type="button" onClick={fn}
                            style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => fetchReport(reportStartDate, reportEndDate)} disabled={reportLoading}
                        style={{ padding: "10px 24px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", width: "fit-content" }}>
                        {reportLoading ? "Loading..." : "📊 Generate Report"}
                      </button>
                    </div>
                    {reportData ? (
                      <div>
                        <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 12 }}>
                          {reportData.startDate} → {reportData.endDate} &nbsp;|&nbsp; {reportData.totalClaims} PA signing{reportData.totalClaims !== 1 ? "s" : ""}, {reportData.totalInspections} inspection{reportData.totalInspections !== 1 ? "s" : ""}
                        </div>
                        {reportData.claimsError ? <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>⚠️ Claims error: {reportData.claimsError}</div> : null}
                        {reportData.inspError ? <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>⚠️ Inspections error: {reportData.inspError}</div> : null}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, padding: "6px 12px", background: "#f3f4f6", borderRadius: 8, marginBottom: 8, fontSize: 11, fontWeight: 700, color: "#6b7280", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                          <div>Homeowner</div>
                          <div style={{ textAlign: "center", width: 36 }}>Insp</div>
                          <div style={{ textAlign: "center", width: 36 }}>LOR</div>
                          <div style={{ textAlign: "center", width: 36 }}>PA</div>
                        </div>
                        {Object.keys(reportData.byRep).sort((a,b) => reportData.byRep[b].length - reportData.byRep[a].length).map(rep => (
                          <div key={rep} style={{ marginBottom: 16 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", padding: "8px 12px", background: "#e0f2fe", borderRadius: 10, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                              <span>👤 {rep}</span>
                              <span style={{ fontSize: 12, color: "#0369a1" }}>{reportData.byRep[rep].length} signing{reportData.byRep[rep].length !== 1 ? "s" : ""}</span>
                            </div>
                            {reportData.byRep[rep].map((s, i) => (
                              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, padding: "8px 12px", background: i%2===0 ? "#fff" : "#f9fafb", borderRadius: 8, marginBottom: 4, alignItems: "center", border: "1px solid #f3f4f6" }}>
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>{s.name}</div>
                                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{s.address}</div>
                                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif" }}>{s.signedAt ? new Date(s.signedAt).toLocaleString() : ""}</div>
                                </div>
                                <div style={{ textAlign: "center", width: 36, fontSize: 16 }}>{s.hasInsp ? "✅" : "○"}</div>
                                <div style={{ textAlign: "center", width: 36, fontSize: 16 }}>{s.hasLor ? "✅" : "○"}</div>
                                <div style={{ textAlign: "center", width: 36, fontSize: 16 }}>{s.hasPac ? "✅" : "○"}</div>
                              </div>
                            ))}
                          </div>
                        ))}
                        {Object.keys(reportData.byRep).length === 0 ? (
                          <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontFamily: "'Nunito', sans-serif", fontSize: 15 }}>No signings recorded this period.</div>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>

                  <div>
                    <Button onClick={() => { setManagerUnlocked(false); setView("input"); }}>
                      Save & Close
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

      </div>

      {/* ── Always-rendered hidden inspection PDF ── */}
      <div style={{ position: "absolute", left: "-20000px", top: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div id="inspection-printable" style={{ fontFamily: "Arial, Helvetica, sans-serif", background: "#fff", width: "8.5in", padding: "0.6in 0.7in", boxSizing: "border-box" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>

            <div style={{ fontSize: 20, fontWeight: 700, color: "#1a2e5a", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1.5 }}>Free Roof Inspection Agreement</div>
            <div style={{ width: 60, height: 3, background: "#c8392b", margin: "0 auto 10px", borderRadius: 2 }} />
            <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }}>
              {INSPECTION_COMPANY.name} &nbsp;|&nbsp; {INSPECTION_COMPANY.address}<br />
              Phone: {INSPECTION_COMPANY.phone} &nbsp;|&nbsp; Email: {INSPECTION_COMPANY.email} &nbsp;|&nbsp; License #: {INSPECTION_COMPANY.license}
            </div>
            <div style={{ borderBottom: "2px solid #1a2e5a", marginTop: 14 }} />
          </div>
          <div style={{ display: "grid", gap: 6, fontSize: 14, marginBottom: 20 }}>
            <div><strong>Date:</strong> {inspData.date || data.date}</div>
            <div><strong>Client:</strong> {inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
            <div><strong>Mobile:</strong> {inspData.mobile || data.phone}</div>
            <div><strong>Address:</strong> {inspData.address || data.address} &nbsp; <strong>City:</strong> {inspData.city || data.city} &nbsp; <strong>St:</strong> {inspData.state || data.state} &nbsp; <strong>Zip:</strong> {inspData.zip || data.zip}</div>
            <div><strong>Email:</strong> {inspData.email || data.signerEmail}</div>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 28, color: "#111827" }}>
            <p style={{ margin: "0 0 10px" }}>Client agrees to allow {INSPECTION_COMPANY.name} (Company) to perform a free roof inspection at the above address and to forward all pictures and findings to a Public Adjuster for review. The Company maintains all required licenses and insurance and will not perform repairs during the inspection.</p>
            <p style={{ margin: "0 0 10px" }}>Client understands that they do not need to be present during the inspection; however, Company personnel will knock on the door upon arrival.</p>
            <p style={{ margin: "0 0 10px" }}>If the Public Adjuster determines that storm damage exists, they may proceed with filing an insurance claim provided the Client has hired them. Client authorizes the Public Adjuster to notify the Company of its findings and to keep the Company updated throughout the claims process.</p>
            <p style={{ margin: 0 }}>Client acknowledges that the Company is a licensed roofing contractor and cannot discuss policy coverages, insurance requirements, or statutory guidelines. Any such questions should be directed to the Public Adjuster or the Client's homeowner's insurance carrier.</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
            <div>
              <div style={{ marginBottom: 4, fontSize: 12 }}>Client:</div>
              <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                {effectiveSig1 ? <img src={effectiveSig1} alt="Client signature" style={{ maxHeight: 44, objectFit: "contain" }} /> : null}
              </div>
              <div style={{ fontSize: 11, color: "#374151" }}>{[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
              <div style={{ fontSize: 12, marginTop: 8 }}>Date: {data.date}</div>
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 12 }}>Representative:</div>
              <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                <img src={REP_FIXED.signatureImage} alt="Rep signature" style={{ maxHeight: 44, objectFit: "contain" }} />
              </div>
              <div style={{ fontSize: 11, color: "#374151" }}>{data.salesRepName || REP_FIXED.name}</div>
              <div style={{ fontSize: 12, marginTop: 8 }}>Date: {data.date}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Always-rendered hidden welcome PDF (needed for email attachment at submit time) ── */}
      <div style={{ position: "absolute", left: "-20000px", top: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div
          id="ty-summary-printable"
          style={{
            width: "8.5in",
            fontFamily: "Arial, Helvetica, sans-serif",
            background: "#fff",
          }}
        >
        <div style={{
          width: "8.5in",
          boxSizing: "border-box",
          padding: "0",
          background: "#fff",
          position: "relative",
        }}>
          {/* Green header */}
          <div style={{
            background: "#199c2e",
            padding: "0.5in 0.6in 0.4in",
            color: "#fff",
          }}>
            <img src="/pa-header.png" alt="Capital Claims Group" style={{ height: 60, marginBottom: 20, filter: "brightness(0) invert(1)" }} />
            <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, lineHeight: 1.1 }}>
              Welcome to Capital Claims Group!
            </div>
            <div style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.5 }}>
              {thankYouOpening}
            </div>
          </div>

          {/* Contact info box */}
          <div style={{ padding: "0.2in 0.5in 0.2in" }}>
            <div style={{
              background: "#f0fdf4",
              border: "2px solid #199c2e",
              borderRadius: 12,
              padding: "20px 24px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#166534", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                Your Point of Contact
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
                <div><strong>Company:</strong> Capital Claims Group</div>
                <div><strong>License:</strong> G240595</div>
                <div><strong>Phone:</strong> +1 (954) 571-3035</div>
                <div><strong>Email:</strong> claims@capitalclaimgroup.com</div>
                <div><strong>Website:</strong> www.ccgclaims.com</div>
                <div><strong>Address:</strong> 3600 Red Rd Ste 601B, Miramar, FL 33025</div>
              </div>
            </div>

            {/* Claim details */}
            <div style={{
              background: "#f8fafc",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: "18px 24px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                Your Claim Details
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 12 }}>
                <div><strong>Name:</strong> {[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
                <div><strong>Date:</strong> {data.date}</div>
                <div><strong>Address:</strong> {[data.address, data.city, data.state, data.zip].filter(Boolean).join(", ")}</div>
                <div><strong>Phone:</strong> {data.phone}</div>
                <div><strong>Insurance Co.:</strong> {data.insuranceCompany}</div>
                <div><strong>Policy #:</strong> {data.policyNumber}</div>
                {data.claimNumber ? <div><strong>Claim #:</strong> {data.claimNumber}</div> : null}
                {data.dateOfLoss ? <div><strong>Date of Loss:</strong> {data.dateOfLoss}</div> : null}
              </div>
            </div>

            {/* What to expect */}
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
              📋 What Happens Next
            </div>
            {activeTYSteps.map((step, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginBottom: 6,
                padding: "7px 10px",
                background: "#f0fdf4",
                borderRadius: 8,
                border: "1px solid #bbf7d0",
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  background: "#199c2e", color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 11, flexShrink: 0,
                }}>{i + 1}</div>
                <div style={{ fontSize: 12, color: "#166534", lineHeight: 1.45 }}>{step}</div>
              </div>
            ))}

            {/* Closing */}
            <div style={{
              marginTop: 20,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 12,
              padding: "16px 20px",
              fontSize: 14,
              color: "#92400e",
              fontWeight: 600,
              textAlign: "center",
              lineHeight: 1.6,
            }}>
              {thankYouClosing}
            </div>

            {/* Footer */}
            <div style={{
              marginTop: 28,
              borderTop: "2px solid #199c2e",
              paddingTop: 14,
              fontSize: 11,
              color: "#6b7280",
              textAlign: "center",
            }}>
              Capital Claims Group Inc. • License No: G240595 • claims@capitalclaimgroup.com • +1 (954) 571-3035 • www.ccgclaims.com
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* ── Submitting overlay ── */}
      {isSubmitting ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(3px)",
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 28,
              padding: "44px 40px",
              textAlign: "center",
              maxWidth: 380,
              width: "90%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
            }}
          >
            {/* Animated spinner */}
            <div style={{ marginBottom: 24 }}>
              <div style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                border: "5px solid #d1fae5",
                borderTop: "5px solid #199c2e",
                margin: "0 auto",
                animation: "ccg-spin 0.9s linear infinite",
              }} />
            </div>
            <div style={{
              fontSize: 26,
              fontWeight: 700,
              color: "#111827",
              fontFamily: "'Oswald', sans-serif",
              marginBottom: 12,
              lineHeight: 1.2,
            }}>
              Submitting Your Documents
            </div>
            <div style={{
              fontSize: 17,
              color: "#4b5563",
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 600,
              lineHeight: 1.6,
              marginBottom: 20,
            }}>
              Please wait — we're saving your signature and sending your copies by email. This takes just a moment. ✉️
            </div>
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 20px",
              background: "#f0fdf4",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 700,
              color: "#166534",
              fontFamily: "'Nunito', sans-serif",
            }}>
              <span>⚠️</span> Please don't close this window
            </div>
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes ccg-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes ccg-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 6px 20px rgba(25,156,46,0.45); }
          50% { transform: scale(1.04); box-shadow: 0 8px 28px rgba(25,156,46,0.65); }
        }
        @keyframes ccg-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
      `}</style>

    </div>
  );
}