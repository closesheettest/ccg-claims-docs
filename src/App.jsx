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
};

function documentLabel(doc) {
  return doc === "pac" ? "PA Agreement" : "Letter of Representation";
}

function documentFilename(doc) {
  return doc === "pac"
    ? "Public-Adjuster-Agreement.pdf"
    : "Letter-of-Representation.pdf";
}

/* =========================
   AUDIT PAGE (FIXED)
   ========================= */

function AuditTrailPage({ auditInfo, data, docLabel, claimId }) {
  if (!auditInfo?.signedAt) return null;

  return (
    <div
      className="pdf-page"
      style={{
        width: "100%",
        minHeight: "11in",
        background: "#fff",
        boxSizing: "border-box",
        overflow: "hidden",

        /* 🔥 FORCE NEW PAGE ALWAYS */
        pageBreakBefore: "always",
        pageBreakAfter: "auto",

        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <div style={{ padding: "0.55in 0.6in" }}>
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
          {[
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
            ["City / State", auditInfo.signedLocation || "Not available"],
            ["Sign method", auditInfo.signMethod],
            ["Browser / device", auditInfo.signedUserAgent],
          ].map(([label, value], i) => (
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
              <div style={{ padding: "14px 16px", fontSize: 13 }}>
                {value || "Not available"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function formatAddress(data) {
  return [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

/* =========================
   LETTER OF REPRESENTATION (FIXED)
   ========================= */

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

  const containerStyle = isExportingPdf
    ? { width: "8.5in", background: "#fff" }
    : {
        background: "#fff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
      };

  const pageStyle = (isLast = false) => ({
    width: "100%",
    minHeight: isExportingPdf ? "11in" : "auto",
    background: "#fff",
    boxSizing: "border-box",

    /* 🔥 FIXED PAGINATION */
    pageBreakAfter: isExportingPdf && !isLast ? "always" : "auto",
  });

  return (
    <div id="lor-printable-document" style={containerStyle}>
      {/* PAGE 1 */}
      <div className="pdf-page" style={pageStyle(false)}>
        <div style={{ padding: "0.5in" }}>
          <h2>Letter of Representation</h2>

          <p><strong>Date:</strong> {data.date}</p>
          <p><strong>Insurance Company:</strong> {data.insuranceCompany}</p>
          <p><strong>Policy #:</strong> {data.policyNumber}</p>
          <p><strong>Claim #:</strong> {data.claimNumber}</p>

          <p><strong>Insured:</strong> {data.homeowner1} {data.homeowner2}</p>

          <p style={{ whiteSpace: "pre-line" }}>
            <strong>Address:</strong>{"\n"}
            {fullAddress}
          </p>

          <p>
            This letter serves as formal notice that the insured has retained
            Capital Claims Group for representation regarding the above claim.
          </p>
        </div>
      </div>

      {/* PAGE 2 SIGNATURE */}
      <div className="pdf-page" style={pageStyle(true)}>
        <div style={{ padding: "0.5in" }}>
          <h3>Signatures</h3>

          <div style={{ marginTop: 20 }}>
            {sig1 && (
              <img
                src={sig1}
                alt="sig1"
                style={{ height: 60 }}
              />
            )}
          </div>

          {hasSecond && (
            <div style={{ marginTop: 20 }}>
              {sig2 && (
                <img
                  src={sig2}
                  alt="sig2"
                  style={{ height: 60 }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 🔥 ALWAYS OWN PAGE */}
      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="Letter of Representation"
        claimId={claimId}
      />
    </div>
  );
}
function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  disabled = false,
}) {
  const baseStyle = {
    height: 44,
    padding: "0 16px",
    borderRadius: 14,
    border: "1px solid #d1d5db",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: disabled ? 0.6 : 1,
  };

  const styles =
    variant === "outline"
      ? { ...baseStyle, background: "#fff", color: "#111827" }
      : {
          ...baseStyle,
          background: "#111827",
          color: "#fff",
          border: "1px solid #111827",
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
    <div style={{ fontSize: 30, fontWeight: 700, color: "#111827" }}>
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

/* =========================
   PA AGREEMENT
   ========================= */

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

  const pageStyle = isExportingPdf
    ? {
        width: "8.5in",
        background: "#fff",
        boxSizing: "border-box",
        overflow: "hidden",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
        pageBreakAfter: "always",
      }
    : {
        width: "100%",
        background: "#fff",
        boxSizing: "border-box",
        overflow: "hidden",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        marginBottom: 16,
      };

  const pageInnerStyle = {
    padding: isExportingPdf ? "0 0.42in 0.12in" : "0 28px 20px",
  };

  const bodyText = {
    fontSize: 12,
    lineHeight: 1.45,
    color: "#111827",
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
    <img
      src={PA_ASSETS.titleBar}
      alt="title"
      style={{ width: "100%", display: "block", margin: "10px 0 12px" }}
    />
  );

  return (
    <div id="pac-printable-document" style={{ background: "transparent" }}>
      <div className="pdf-page" style={pageStyle}>
        <HeaderImg />
        <div style={pageInnerStyle}>
          <div style={bodyText}>
            <div style={{ marginTop: 10, marginBottom: 10 }}>
              <strong>Insured:</strong> {insuredNames}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Phone:</strong> {data.phone}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Email:</strong> {data.signerEmail}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Insurer:</strong> {data.insuranceCompany}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Policy #:</strong> {data.policyNumber}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Claim #:</strong> {data.claimNumber}
            </div>
            <div style={{ marginBottom: 10 }}>
              <strong>Date of Loss:</strong> {data.dateOfLoss}
            </div>
            <TitleBarImg />

            <p>
              The insured retains Capital Claims Group as public adjuster for the
              above referenced claim. The insured agrees to the fee structure and
              terms contained in this agreement.
            </p>

            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 11, marginBottom: 6 }}>Initials:</div>
              <div style={{ minHeight: 24 }}>
                {data.initials1 ? (
                  <img src={data.initials1} alt="initials1" style={{ height: 18 }} />
                ) : null}
              </div>
            </div>

            {hasSecond ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, marginBottom: 6 }}>Initials:</div>
                <div style={{ minHeight: 24 }}>
                  {data.initials2 ? (
                    <img src={data.initials2} alt="initials2" style={{ height: 18 }} />
                  ) : null}
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 28 }}>
              <div style={{ marginBottom: 12, fontWeight: 700 }}>
                CAPITAL CLAIMS GROUP
              </div>

              <div style={{ marginBottom: 8 }}>By: {PA_FIXED.name}</div>
              <div style={{ marginBottom: 8 }}>License: {PA_FIXED.license}</div>
              <div style={{ marginBottom: 16 }}>
                <img
                  src={PA_FIXED.signatureImage}
                  alt="PA signature"
                  style={{ height: 24 }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <div>Insured (Print): {data.homeowner1}</div>
                <div style={{ minHeight: 38, marginTop: 6 }}>
                  {sig1 ? <img src={sig1} alt="sig1" style={{ height: 30 }} /> : null}
                </div>
              </div>

              {hasSecond ? (
                <div style={{ marginBottom: 18 }}>
                  <div>Insured (Print): {data.homeowner2}</div>
                  <div style={{ minHeight: 38, marginTop: 6 }}>
                    {sig2 ? <img src={sig2} alt="sig2" style={{ height: 30 }} /> : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <FooterImg />
          </div>
        </div>
      </div>

      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="PA Agreement"
        claimId={claimId}
      />
    </div>
  );
}

/* =========================
   APP
   ========================= */

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

  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");
  const [typedSig1, setTypedSig1] = useState("");
  const [typedSig2, setTypedSig2] = useState("");
  const [sigMethod1, setSigMethod1] = useState("draw");
  const [sigMethod2, setSigMethod2] = useState("draw");
  const [sigFont1, setSigFont1] = useState(`"Brush Script MT", cursive`);
  const [sigFont2, setSigFont2] = useState(`"Brush Script MT", cursive`);

  const [initials1Typed, setInitials1Typed] = useState("");
  const [initials2Typed, setInitials2Typed] = useState("");
  const [initialsMethod1, setInitialsMethod1] = useState("draw");
  const [initialsMethod2, setInitialsMethod2] = useState("draw");
  const [initialsFont1, setInitialsFont1] = useState(`"Brush Script MT", cursive`);
  const [initialsFont2, setInitialsFont2] = useState(`"Brush Script MT", cursive`);

  const hasSecond = Boolean(data.homeowner2?.trim());

  const propertyAddressText = [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

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
          signedLocation:
            [claim.signed_city, claim.signed_region].filter(Boolean).join(", ") ||
            "",
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

        setView("sign");
      } finally {
        setIsLoadingSigningLink(false);
      }
    };

    loadFromSigningLink();
  }, []);

  const update = (key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const parseJsonResponse = async (response, fallbackMessage) => {
    const rawText = await response.text();
    let result = {};

    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
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
    setData((prev) => ({ ...prev, initials1: "", initials2: "" }));
    setInitials1Typed("");
    setInitials2Typed("");
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
      if (hasSecond && !effectiveInitials2) missing.push("Homeowner 2 initials");
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
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 1.4, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
        pagebreak: { mode: ["css"] },
      };

      return await html2pdf().set(opt).from(element).outputPdf("blob");
    } finally {
      setIsExportingPdf(false);
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

        const signingLink = `${window.location.origin}/?sign=1&docs=${selectedDocs.join(",")}&claim=${record?.id}`;

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
              <p>Please click the link below to review and sign your document${selectedDocs.length > 1 ? "s" : ""}.</p>
              <p><a href="${signingLink}">${signingLink}</a></p>
              <p><strong>Forms included:</strong></p>
              <ul>${selectedDocs.map((doc) => `<li>${documentLabel(doc)}</li>`).join("")}</ul>
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
          signedByName: [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
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
        signedLocation:
          [serverAudit.signedCity, serverAudit.signedRegion].filter(Boolean).join(", ") ||
          "",
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
          "Letter-of-Representation.pdf"
        );
        const lorBase64 = await blobToBase64(lorBlob);
        attachments.push({
          filename: "Letter-of-Representation.pdf",
          content: String(lorBase64).split(",")[1],
        });
      }

      if (selectedDocs.includes("pac")) {
        const pacBlob = await generatePDF(
          "#pac-printable-document",
          "Public-Adjuster-Agreement.pdf"
        );
        const pacBase64 = await blobToBase64(pacBlob);
        attachments.push({
          filename: "Public-Adjuster-Agreement.pdf",
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
            <p><strong>City / State:</strong> ${nextAuditInfo.signedLocation || ""}</p>
          `,
          attachments,
        }),
      });

      await parseJsonResponse(finalEmailResponse, "Final signed email failed.");

      alert("Saved successfully! Signed document email sent.");
      setView("input");
      setPendingSend(false);

      if (isSigningFromLink) {
        window.history.replaceState({}, "", window.location.pathname);
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
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        Loading signing request...
      </div>
    );
  }

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
        body {
          margin: 0;
          font-family: Arial, Helvetica, sans-serif;
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
              <CardTitle>Claim Intake</CardTitle>
              <CardDescription>
                Enter the information once, choose sign now or send for signing,
                choose which forms to include, then continue.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <div style={{ display: "grid", gap: 24 }}>
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Homeowner Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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
                    <FileSignature size={16} /> PA Agreement
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

        {view === "sign" ? (
          <>
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  setView("input");
                  if (isSigningFromLink) {
                    window.history.replaceState({}, "", window.location.pathname);
                    setIsSigningFromLink(false);
                  }
                }}
              >
                <ArrowLeft size={16} /> Back
              </Button>
            </div>

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

            <Card>
              <CardHeader>
                <CardTitle>
                  {pendingSend ? "Review & Send for Signing" : "Sign Document(s)"}
                </CardTitle>
                <CardDescription>
                  {pendingSend
                    ? "Review the selected forms, then email one signing link to the homeowner."
                    : "Complete all required signatures and initials before submitting."}
                </CardDescription>
              </CardHeader>

              <CardContent>
                {!pendingSend ? (
                  <>
                    <div
                      style={{
                        background: "#fef2f2",
                        color: "#991b1b",
                        border: "1px solid #fecaca",
                        borderRadius: 12,
                        padding: 12,
                        marginBottom: 16,
                        fontSize: 14,
                        fontWeight: 600,
                      }}
                    >
                      Please complete all required signatures
                      {selectedDocs.includes("pac") ? " and initials" : ""} before
                      submitting.
                    </div>

                    <div style={{ marginBottom: 14 }}>
                      <div
                        style={{
                          fontWeight: 800,
                          color: "#1d4ed8",
                          textDecoration: "underline",
                          marginBottom: 10,
                          cursor: "pointer",
                          fontSize: 14,
                        }}
                        onClick={() =>
                          setSigMethod1(sigMethod1 === "draw" ? "type" : "draw")
                        }
                      >
                        {sigMethod1 === "draw"
                          ? "PREFER TO TYPE INSTEAD?"
                          : "PREFER TO DRAW INSTEAD?"}
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
                        <div style={{ marginBottom: 16 }}>
                          <Label>Homeowner 1 Signature *</Label>
                          <input
                            value={typedSig1}
                            onChange={(e) => setTypedSig1(e.target.value)}
                            placeholder="Type Homeowner 1 full name"
                            style={{
                              width: "100%",
                              height: 44,
                              borderRadius: 12,
                              border: "1px solid #d1d5db",
                              padding: "0 12px",
                              marginBottom: 10,
                              boxSizing: "border-box",
                            }}
                          />
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {[
                              `"Brush Script MT", cursive`,
                              `"Segoe Script", cursive`,
                              `"Lucida Handwriting", cursive`,
                            ].map((font, idx) => (
                              <button
                                key={font}
                                type="button"
                                onClick={() => setSigFont1(font)}
                                style={{
                                  border:
                                    sigFont1 === font
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
                                {typedSig1 || `Style ${idx + 1}`}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {hasSecond ? (
                      <div style={{ marginBottom: 14 }}>
                        <div
                          style={{
                            fontWeight: 800,
                            color: "#1d4ed8",
                            textDecoration: "underline",
                            marginBottom: 10,
                            cursor: "pointer",
                            fontSize: 14,
                          }}
                          onClick={() =>
                            setSigMethod2(sigMethod2 === "draw" ? "type" : "draw")
                          }
                        >
                          {sigMethod2 === "draw"
                            ? "PREFER TO TYPE INSTEAD?"
                            : "PREFER TO DRAW INSTEAD?"}
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
                          <div style={{ marginBottom: 16 }}>
                            <Label>Homeowner 2 Signature *</Label>
                            <input
                              value={typedSig2}
                              onChange={(e) => setTypedSig2(e.target.value)}
                              placeholder="Type Homeowner 2 full name"
                              style={{
                                width: "100%",
                                height: 44,
                                borderRadius: 12,
                                border: "1px solid #d1d5db",
                                padding: "0 12px",
                                marginBottom: 10,
                                boxSizing: "border-box",
                              }}
                            />
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                              {[
                                `"Brush Script MT", cursive`,
                                `"Segoe Script", cursive`,
                                `"Lucida Handwriting", cursive`,
                              ].map((font, idx) => (
                                <button
                                  key={font}
                                  type="button"
                                  onClick={() => setSigFont2(font)}
                                  style={{
                                    border:
                                      sigFont2 === font
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
                                  {typedSig2 || `Style ${idx + 1}`}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {selectedDocs.includes("pac") ? (
                      <>
                        <div
                          style={{
                            fontWeight: 800,
                            color: "#1d4ed8",
                            textDecoration: "underline",
                            marginBottom: 10,
                            cursor: "pointer",
                            fontSize: 14,
                          }}
                          onClick={() =>
                            setInitialsMethod1(
                              initialsMethod1 === "draw" ? "type" : "draw"
                            )
                          }
                        >
                          {initialsMethod1 === "draw"
                            ? "PREFER TO TYPE INITIALS INSTEAD?"
                            : "PREFER TO DRAW INITIALS INSTEAD?"}
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
                          <div style={{ marginBottom: 16 }}>
                            <Label>Homeowner 1 Initials *</Label>
                            <input
                              value={initials1Typed}
                              onChange={(e) => setInitials1Typed(e.target.value)}
                              placeholder="Type Homeowner 1 initials"
                              style={{
                                width: "100%",
                                height: 44,
                                borderRadius: 12,
                                border: "1px solid #d1d5db",
                                padding: "0 12px",
                                marginBottom: 10,
                                boxSizing: "border-box",
                              }}
                            />
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                              {[
                                `"Brush Script MT", cursive`,
                                `"Segoe Script", cursive`,
                                `"Lucida Handwriting", cursive`,
                              ].map((font, idx) => (
                                <button
                                  key={font}
                                  type="button"
                                  onClick={() => setInitialsFont1(font)}
                                  style={{
                                    border:
                                      initialsFont1 === font
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
                                  {initials1Typed || `Style ${idx + 1}`}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {hasSecond ? (
                          <>
                            <div
                              style={{
                                fontWeight: 800,
                                color: "#1d4ed8",
                                textDecoration: "underline",
                                marginBottom: 10,
                                cursor: "pointer",
                                fontSize: 14,
                              }}
                              onClick={() =>
                                setInitialsMethod2(
                                  initialsMethod2 === "draw" ? "type" : "draw"
                                )
                              }
                            >
                              {initialsMethod2 === "draw"
                                ? "PREFER TO TYPE INITIALS INSTEAD?"
                                : "PREFER TO DRAW INITIALS INSTEAD?"}
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
                              <div style={{ marginBottom: 16 }}>
                                <Label>Homeowner 2 Initials *</Label>
                                <input
                                  value={initials2Typed}
                                  onChange={(e) => setInitials2Typed(e.target.value)}
                                  placeholder="Type Homeowner 2 initials"
                                  style={{
                                    width: "100%",
                                    height: 44,
                                    borderRadius: 12,
                                    border: "1px solid #d1d5db",
                                    padding: "0 12px",
                                    marginBottom: 10,
                                    boxSizing: "border-box",
                                  }}
                                />
                                <div
                                  style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
                                >
                                  {[
                                    `"Brush Script MT", cursive`,
                                    `"Segoe Script", cursive`,
                                    `"Lucida Handwriting", cursive`,
                                  ].map((font, idx) => (
                                    <button
                                      key={font}
                                      type="button"
                                      onClick={() => setInitialsFont2(font)}
                                      style={{
                                        border:
                                          initialsFont2 === font
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
                                      {initials2Typed || `Style ${idx + 1}`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : null}

                {!pendingSend && missingSigningFields.length > 0 ? (
                  <div
                    style={{
                      marginTop: 8,
                      marginBottom: 12,
                      fontSize: 13,
                      color: "#991b1b",
                    }}
                  >
                    Missing: {missingSigningFields.join(", ")}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 12, paddingTop: 8, flexWrap: "wrap" }}>
                  <Button
                    onClick={submitDoc}
                    disabled={!pendingSend && !isSigningComplete}
                  >
                    {pendingSend ? <Send size={16} /> : <Mail size={16} />}
                    {pendingSend ? "Send for Signing" : "Submit & Email Copies"}
                  </Button>

                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        const selector = selectedDocs.includes("lor")
                          ? "#lor-printable-document"
                          : "#pac-printable-document";
                        const filename = selectedDocs.includes("lor")
                          ? "Letter-of-Representation.pdf"
                          : "Public-Adjuster-Agreement.pdf";

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
                            image: { type: "jpeg", quality: 0.95 },
                            html2canvas: { scale: 1.4, useCORS: true },
                            jsPDF: {
                              unit: "in",
                              format: "letter",
                              orientation: "portrait",
                            },
                            pagebreak: { mode: ["css", "legacy"] },
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
          </>
        ) : null}
      </div>
    </div>
  );
}