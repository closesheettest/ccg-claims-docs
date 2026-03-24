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
  link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap";
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

const VALID_DOCS = ["lor", "pac"];

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
  homeowner1: "",
  homeowner2: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  situation: "",
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
  return doc === "pac" ? "PA Authorization" : "Letter of Representation";
}

function documentFilename(doc) {
  return doc === "pac"
    ? "Public-Adjuster-Authorization.pdf"
    : "Letter-of-Representation.pdf";
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
    <div style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
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
        fontWeight: 500,
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

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <Label>
          {title}
          {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
        </Label>
        <Button variant="outline" onClick={clear}>
          <RotateCcw size={16} /> Clear
        </Button>
      </div>

      <div
        style={{
          border: missing ? "2px dashed #dc2626" : "1px dashed #cbd5e1",
          borderRadius: 16,
          background: missing ? "#fef2f2" : "#fff",
          padding: 8,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height,
            borderRadius: 12,
            background: "#f8fafc",
            touchAction: "none",
            display: "block",
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

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
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

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <Label>
          {title}
          {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
        </Label>
        <button
          type="button"
          onClick={clear}
          style={{
            background: "transparent",
            border: "none",
            color: "#6b7280",
            fontSize: 12,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Clear
        </button>
      </div>

      <div
        style={{
          border: missing ? "2px dashed #dc2626" : "1px dashed #cbd5e1",
          borderRadius: 12,
          background: missing ? "#fef2f2" : "#fff",
          padding: 8,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: 42,
            display: "block",
            background: "#f8fafc",
            touchAction: "none",
            borderRadius: 8,
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

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
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
      Public Adjuster Authorization
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
        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>PA Initials:</div>
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
        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
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
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
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
            fontSize: 10,
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
          <p style={{ margin: "0 0 10px" }}>
            The insured(s) hereby retains Capital Claims Group to be its public
            adjuster and hereby appoints Capital Claims Group to be its
            independent appraiser to appraise, advise, negotiate, and/or settle
            the above-referenced claim. The insured(s) agrees to pay and hereby
            assigns to Capital Claims Group <strong>10%</strong> of all payments
            made by the insurance company related to this claim. In the event
            appraisal, mediation is demanded, or a lawsuit ensues regarding the
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

          <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
            12.{" "}
            <span style={{ color: "#199c2e" }}>
              Residential Policy Cancellation:
            </span>
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700 }}>
            You, the insured, may cancel this contract for any reason without
            penalty or obligation to you within 10 days after the date of this
            contract.
          </p>

          <p style={{ margin: 0, fontWeight: 700 }}>
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
          <p style={{ margin: "0 0 12px", fontWeight: 700 }}>
            The notice of cancellation shall be provided to Capital Claims
            Group, submitted in writing, and sent by certified mail, return
            receipt requested, or another form of mailing that provides proof
            thereof, at the address specified in the contract.
          </p>

          <p style={{ margin: "0 0 16px", fontWeight: 700 }}>
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

          <p style={{ margin: "0 0 10px" }}>
            Insured(s) have read, understand and voluntarily sign the foregoing
            Agreement. A computer or faxed signature or copy of this document
            shall be deemed to have the same effect as the original.
          </p>

          <InitialsRow />

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
                <div style={{ fontSize: 11 }}>
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
                  <div style={{ fontSize: 11 }}>
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
  const [selectedDocs, setSelectedDocs] = useState(["lor"]);
  const [signMode, setSignMode] = useState("now");
  const [data, setData] = useState(initialData);
  const [pendingSend, setPendingSend] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [currentClaimId, setCurrentClaimId] = useState(null);
  const [isSigningFromLink, setIsSigningFromLink] = useState(false);
  const [isLoadingSigningLink, setIsLoadingSigningLink] = useState(false);
  const [auditInfo, setAuditInfo] = useState(initialAuditInfo);

  // Manager-editable content
  const [reviewHeadline, setReviewHeadline] = useState("Two quick documents stand between you and getting your claim moving.");
  const [reviewLorText, setReviewLorText] = useState(LOR_REVIEW_TEXT);
  const [reviewPacText, setReviewPacText] = useState(PAC_REVIEW_TEXT);
  const [reviewHelpText, setReviewHelpText] = useState("Preview each document first if you'd like, then click 'Click to Authorize' for both before signing.");
  const [thankYouHeadline, setThankYouHeadline] = useState("You're All Set!");
  const [thankYouBody, setThankYouBody] = useState("Thank you for authorizing your documents. Your public adjuster will be in touch shortly to get your claim moving. You can close this window.");
  const [managerPin, setManagerPin] = useState("1234");
  const [managerPinEntry, setManagerPinEntry] = useState("");
  const [managerUnlocked, setManagerUnlocked] = useState(false);

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

  const hasSecond = Boolean(data.homeowner2?.trim());

  const propertyAddressText = [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  const reviewReady =
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

  const beginDocumentFlow = () => {
    if (!selectedDocs.length) {
      alert("Please select at least one form.");
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
    setView("sign");
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
      representative_name: data.representativeName,
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

  const submitDoc = async () => {
    try {
      if (!pendingSend && !isSigningComplete) {
        alert(
          "Please complete the required signing fields:\n\n" +
            missingSigningFields.join("\n")
        );
        return;
      }

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
        alert(`Signing link sent to ${data.signerEmail}.`);
        setView("input");
        setPendingSend(false);
        return;
      }

      const auditResponse = await fetch("/.netlify/functions/sign-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimId: currentClaimId,
          docType: selectedDocs.join(","),
          signMethod: isSigningFromLink ? "email_link" : "sign_now",
          signedByEmail: data.signerEmail,
          signedByName: [data.homeowner1, data.homeowner2]
            .filter(Boolean)
            .join(", "),
        }),
      });

      const serverAudit = await parseJsonResponse(
        auditResponse,
        "Failed to capture signing audit trail."
      );

      const nextAuditInfo = {
        signedAt: serverAudit.signedAt || "",
        signedIp: serverAudit.signedIp || "",
        signedUserAgent: serverAudit.signedUserAgent || "",
        signMethod: serverAudit.signMethod || "",
        signedByEmail: serverAudit.signedByEmail || data.signerEmail || "",
        signedByName:
          serverAudit.signedByName ||
          [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
        signedCity: serverAudit.signedCity || "",
        signedRegion: serverAudit.signedRegion || "",
      };

      setAuditInfo(nextAuditInfo);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { error } = await saveClaimToSupabase(nextAuditInfo);
      if (error) {
        alert("Error saving: " + error.message);
        return;
      }

      const attachments = [];

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

      const finalEmailResponse = await fetch("/.netlify/functions/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [data.signerEmail, data.paEmail].filter(Boolean),
          subject:
            selectedDocs.length > 1
              ? "Signed Claim Documents Submitted"
              : `${documentLabel(selectedDocs[0])} Submitted`,
          html: `
            <h2>Claim Document Submitted</h2>
            <p><strong>Forms included:</strong> ${selectedDocs
              .map(documentLabel)
              .join(", ")}</p>
            <p><strong>Signed at:</strong> ${nextAuditInfo.signedAt || ""}</p>
            <p><strong>Signing IP:</strong> ${nextAuditInfo.signedIp || ""}</p>
            ${
              nextAuditInfo.signedCity || nextAuditInfo.signedRegion
                ? `<p><strong>City / State:</strong> ${[
                    nextAuditInfo.signedCity,
                    nextAuditInfo.signedRegion,
                  ]
                    .filter(Boolean)
                    .join(", ")}</p>`
                : ""
            }
          `,
          attachments,
        }),
      });

      await parseJsonResponse(finalEmailResponse, "Final signed email failed.");

      setPendingSend(false);

      if (isSigningFromLink) {
        window.history.replaceState({}, "", window.location.pathname);
        setView("thankyou");
      } else {
        alert("Saved successfully! Signed document email sent.");
        setView("input");
      }
    } catch (err) {
      alert(err?.message || "Something went wrong.");
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

  const renderSigningFields = (showSendMode = false) => (
    <Card>
      <CardHeader>
        <CardTitle>
          {showSendMode ? "Review & Send for Signing" : "Sign to Authorize"}
        </CardTitle>
        <CardDescription>
          {showSendMode
            ? "Review the selected forms, then email one signing link to the homeowner."
            : "You're almost done — add your signature and initials below to authorize."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!showSendMode ? (
          <>
            {!reviewReady && isSigningFromLink ? (
              <div
                style={{
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  border: "1px solid #bfdbfe",
                  borderRadius: 12,
                  padding: 12,
                  marginBottom: 16,
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Please click "Click to Authorize" for all documents above before signing.
              </div>
            ) : null}



            {/* ── Signature method instruction banner ── */}
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderLeft: "4px solid #199c2e",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 20,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, color: "#166534", marginBottom: 6, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em" }}>
                HOW TO SIGN
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14, color: "#374151" }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>✍️</span>
                  <span><strong>Touch / Mouse:</strong> Draw your signature directly in the box below using your finger (phone/tablet) or mouse (computer).</span>
                </div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14, color: "#374151" }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>⌨️</span>
                  <span><strong>No touchscreen?</strong> Click the <em>"Switch to Typed Signature"</em> button below, type your name, and choose a signature style.</span>
                </div>
              </div>
            </div>

            {/* Sig method toggle button */}
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => setSigMethod1(sigMethod1 === "draw" ? "type" : "draw")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: "1.5px solid #199c2e",
                  background: "#fff",
                  color: "#199c2e",
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 600,
                  fontSize: 13,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {sigMethod1 === "draw" ? "⌨️ Switch to Typed Signature" : "✍️ Switch to Draw Signature"}
              </button>
            </div>

            {sigMethod1 === "draw" ? (
              <SignaturePad
                title="Homeowner 1 Signature"
                value={sig1}
                onChange={setSig1}
                required
                missing={!effectiveSig1}
              />
            ) : (
              <TypedSignatureField
                title="Homeowner 1 Signature"
                value={typedSig1}
                onChange={setTypedSig1}
                fontValue={sigFont1}
                onFontChange={setSigFont1}
                required
                missing={!effectiveSig1}
                placeholder="Type your full name"
              />
            )}

            {hasSecond ? (
              <>
                <div style={{ marginBottom: 12, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => setSigMethod2(sigMethod2 === "draw" ? "type" : "draw")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 16px",
                      borderRadius: 10,
                      border: "1.5px solid #199c2e",
                      background: "#fff",
                      color: "#199c2e",
                      fontFamily: "'Oswald', sans-serif",
                      fontWeight: 600,
                      fontSize: 13,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {sigMethod2 === "draw" ? "⌨️ Switch to Typed Signature" : "✍️ Switch to Draw Signature"}
                  </button>
                </div>

                {sigMethod2 === "draw" ? (
                  <SignaturePad
                    title="Homeowner 2 Signature"
                    value={sig2}
                    onChange={setSig2}
                    required
                    missing={!effectiveSig2}
                  />
                ) : (
                  <TypedSignatureField
                    title="Homeowner 2 Signature"
                    value={typedSig2}
                    onChange={setTypedSig2}
                    fontValue={sigFont2}
                    onFontChange={setSigFont2}
                    required
                    missing={!effectiveSig2}
                    placeholder="Type your full name"
                  />
                )}
              </>
            ) : null}

            {selectedDocs.includes("pac") ? (
              <>
                <div
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e5e7eb",
                    borderLeft: "4px solid #199c2e",
                    borderRadius: 10,
                    padding: "10px 14px",
                    marginBottom: 14,
                    marginTop: 8,
                    fontSize: 13,
                    color: "#374151",
                  }}
                >
                  <strong>Initials:</strong> Draw your initials in the box below, or click the button to type them instead.
                </div>
                <div style={{ marginBottom: 12, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => setInitialsMethod1(initialsMethod1 === "draw" ? "type" : "draw")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 16px",
                      borderRadius: 10,
                      border: "1.5px solid #199c2e",
                      background: "#fff",
                      color: "#199c2e",
                      fontFamily: "'Oswald', sans-serif",
                      fontWeight: 600,
                      fontSize: 13,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {initialsMethod1 === "draw" ? "⌨️ Switch to Typed Initials" : "✍️ Switch to Draw Initials"}
                  </button>
                </div>

                {initialsMethod1 === "draw" ? (
                  <InitialsPad
                    title="Homeowner 1 Initials"
                    value={data.initials1}
                    onChange={(v) => update("initials1", v)}
                    required
                    missing={!effectiveInitials1}
                  />
                ) : (
                  <TypedInitialsField
                    title="Homeowner 1 Initials"
                    value={initials1Typed}
                    onChange={setInitials1Typed}
                    fontValue={initialsFont1}
                    onFontChange={setInitialsFont1}
                    required
                    missing={!effectiveInitials1}
                    placeholder="Type Homeowner 1 initials"
                  />
                )}

                {hasSecond ? (
                  <>
                    <div style={{ marginBottom: 12, marginTop: 8 }}>
                      <button
                        type="button"
                        onClick={() => setInitialsMethod2(initialsMethod2 === "draw" ? "type" : "draw")}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 16px",
                          borderRadius: 10,
                          border: "1.5px solid #199c2e",
                          background: "#fff",
                          color: "#199c2e",
                          fontFamily: "'Oswald', sans-serif",
                          fontWeight: 600,
                          fontSize: 13,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                          cursor: "pointer",
                        }}
                      >
                        {initialsMethod2 === "draw" ? "⌨️ Switch to Typed Initials" : "✍️ Switch to Draw Initials"}
                      </button>
                    </div>

                    {initialsMethod2 === "draw" ? (
                      <InitialsPad
                        title="Homeowner 2 Initials"
                        value={data.initials2}
                        onChange={(v) => update("initials2", v)}
                        required
                        missing={!effectiveInitials2}
                      />
                    ) : (
                      <TypedInitialsField
                        title="Homeowner 2 Initials"
                        value={initials2Typed}
                        onChange={setInitials2Typed}
                        fontValue={initialsFont2}
                        onFontChange={setInitialsFont2}
                        required
                        missing={!effectiveInitials2}
                        placeholder="Type Homeowner 2 initials"
                      />
                    )}
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {!showSendMode && missingSigningFields.length > 0 ? (
          <div
            style={{
              marginTop: 8,
              marginBottom: 12,
              fontSize: 13,
              color: "#991b1b",
            }}
          >
            Still needed: {missingSigningFields.join(", ")}
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
              showSendMode ? false : !reviewReady || !isSigningComplete
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
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap');
        body {
          margin: 0;
          font-family: 'Oswald', Arial, Helvetica, sans-serif;
        }
        input, textarea, select, button {
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
                    <FormField
                      label="Phone"
                      value={data.phone}
                      onChange={(v) => update("phone", v)}
                    />
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
                      <div
                        style={{
                          fontSize: 12,
                          color: "#6b7280",
                          marginTop: 4,
                        }}
                      >
                        Only fill this out if there is an active claim.
                      </div>
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <CheckboxField
                        label="Loss location is same as property address"
                        checked={data.lossLocationSameAsAddress}
                        onChange={(checked) =>
                          update("lossLocationSameAsAddress", checked)
                        }
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
                      label="Representative Name"
                      value={data.representativeName}
                      onChange={(v) => update("representativeName", v)}
                    />
                    <FormField
                      label="PA Email"
                      type="email"
                      value={data.paEmail}
                      onChange={(v) => update("paEmail", v)}
                    />
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

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 12,
                  }}
                >
                  <Button
                    variant={selectedDocs.includes("lor") ? "default" : "outline"}
                    onClick={() => toggleDocSelection("lor")}
                  >
                    <FileSignature size={16} /> Letter of Representation
                  </Button>

                  <Button
                    variant={selectedDocs.includes("pac") ? "default" : "outline"}
                    onClick={() => toggleDocSelection("pac")}
                  >
                    <FileSignature size={16} /> PA Authorization
                  </Button>
                </div>

                <div
                  style={{
                    fontSize: 13,
                    color: "#6b7280",
                    marginTop: 10,
                  }}
                >
                  You can send one form or both in a single signing email.
                </div>
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

            <Card>
              <CardContent>
                <div
                  style={{
                    fontSize: 42,
                    fontWeight: 700,
                    color: "#111827",
                    lineHeight: 1.1,
                    marginBottom: 6,
                    fontFamily: "'Oswald', sans-serif",
                    letterSpacing: "0.01em",
                  }}
                >
                  Review Before Authorizing
                </div>
                <div style={{ width: 60, height: 4, background: "#199c2e", borderRadius: 2, marginBottom: 20 }} />

                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 400,
                    color: "#4b5563",
                    lineHeight: 1.5,
                    marginBottom: 28,
                  }}
                >
                  {reviewHeadline}
                </div>

                {selectedDocs.includes("lor") ? (
                  <div
                    style={{
                      marginBottom: 28,
                      padding: 24,
                      border: "1px solid #d1fae5",
                      borderLeft: "4px solid #199c2e",
                      borderRadius: 20,
                      background: "#f0fdf4",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        color: "#199c2e",
                        marginBottom: 8,
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      ① Letter of Representation
                    </div>

                    <div
                      style={{
                        fontSize: 16,
                        lineHeight: 1.65,
                        color: "#374151",
                        marginBottom: 20,
                      }}
                    >
                      {reviewLorText}
                    </div>

                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <Button variant="outline" onClick={() => previewDocument("lor")}>
                        Preview Letter of Representation
                      </Button>

                      <Button onClick={() => setLorAgreed(true)} style={lorAgreed ? {background:"#15803d", border:"1px solid #15803d"} : {}}>
                        {lorAgreed ? "✓ Authorized" : "Click to Authorize"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selectedDocs.includes("pac") ? (
                  <div
                    style={{
                      marginBottom: 28,
                      padding: 24,
                      border: "1px solid #d1fae5",
                      borderLeft: "4px solid #199c2e",
                      borderRadius: 20,
                      background: "#f0fdf4",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        color: "#199c2e",
                        marginBottom: 8,
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      ② Public Adjuster Authorization
                    </div>

                    <div
                      style={{
                        fontSize: 16,
                        lineHeight: 1.65,
                        color: "#374151",
                        marginBottom: 20,
                      }}
                    >
                      {reviewPacText}
                    </div>

                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <Button variant="outline" onClick={() => previewDocument("pac")}>
                        Preview PA Authorization
                      </Button>

                      <Button onClick={() => setPacAgreed(true)} style={pacAgreed ? {background:"#15803d", border:"1px solid #15803d"} : {}}>
                        {pacAgreed ? "✓ Authorized" : "Click to Authorize"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 500,
                    color: "#6b7280",
                    lineHeight: 1.6,
                    marginBottom: 10,
                    fontStyle: "italic",
                  }}
                >
                  {reviewHelpText}
                </div>
              </CardContent>
            </Card>

            <div id="signature-section" style={{ scrollMarginTop: 20 }}>
              {renderSigningFields(false)}
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
        {/* ── THANK YOU VIEW ── */}
        {view === "thankyou" ? (
          <div
            style={{
              minHeight: "70vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ textAlign: "center", maxWidth: 540, padding: "0 16px" }}>
              <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
              <div
                style={{
                  fontSize: 38,
                  fontWeight: 700,
                  color: "#111827",
                  fontFamily: "'Oswald', sans-serif",
                  marginBottom: 12,
                  lineHeight: 1.1,
                }}
              >
                {thankYouHeadline}
              </div>
              <div style={{ width: 60, height: 4, background: "#199c2e", borderRadius: 2, margin: "0 auto 20px" }} />
              <div
                style={{
                  fontSize: 17,
                  color: "#4b5563",
                  lineHeight: 1.7,
                  marginBottom: 32,
                }}
              >
                {thankYouBody}
              </div>
              <img
                src="/pa-header.png"
                alt="Capital Claims Group"
                style={{ maxWidth: 280, opacity: 0.85 }}
              />
            </div>
          </div>
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
                    <div style={{ maxWidth: 300 }}>
                      <Label>Change Manager PIN</Label>
                      <input
                        type="password"
                        value={managerPin}
                        onChange={(e) => setManagerPin(e.target.value)}
                        placeholder="New PIN"
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

                  {/* Thank you page text */}
                  <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Thank You Page Text</SectionTitle>
                    <div style={{ display: "grid", gap: 16 }}>
                      <div>
                        <Label>Headline</Label>
                        <input
                          type="text"
                          value={thankYouHeadline}
                          onChange={(e) => setThankYouHeadline(e.target.value)}
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
                      <div>
                        <Label>Body message</Label>
                        <textarea
                          value={thankYouBody}
                          onChange={(e) => setThankYouBody(e.target.value)}
                          rows={4}
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

                    {/* Live preview */}
                    <div style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                      <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
                        Preview
                      </div>
                      <div style={{ background: "#fff", borderRadius: 16, padding: "24px 20px", textAlign: "center", border: "1px solid #e5e7eb" }}>
                        <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
                        <div style={{ fontSize: 24, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>
                          {thankYouHeadline}
                        </div>
                        <div style={{ width: 40, height: 3, background: "#199c2e", borderRadius: 2, margin: "0 auto 12px" }} />
                        <div style={{ fontSize: 14, color: "#4b5563", lineHeight: 1.7 }}>
                          {thankYouBody}
                        </div>
                      </div>
                    </div>
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
    </div>
  );
}