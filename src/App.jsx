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
      ? {
          ...baseStyle,
          background: "#fff",
          color: "#111827",
        }
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

function FieldBox({ children }) {
  return (
    <div
      style={{
        minHeight: 44,
        border: "1px solid #d1d5db",
        borderRadius: 14,
        padding: "10px 12px",
        background: "#fff",
        fontSize: 14,
        color: "#111827",
      }}
    >
      {children}
    </div>
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

function SignaturePad({ title, value, onChange, height = 160 }) {
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        <Label>{title}</Label>
        <Button variant="outline" onClick={clear}>
          <RotateCcw size={16} /> Clear
        </Button>
      </div>

      <div
        style={{
          border: "1px dashed #cbd5e1",
          borderRadius: 16,
          background: "#fff",
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
    </div>
  );
}

function InitialsPad({ title, value, onChange }) {
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    onChange("");
  };

  return (
    <div style={{ marginTop: 6, marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 400, color: "#111827" }}>
          {title}
        </div>
        <button
          type="button"
          onClick={clear}
          style={{
            background: "transparent",
            border: "none",
            color: "#6b7280",
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Clear
        </button>
      </div>

      <canvas
        ref={canvasRef}
        style={{
          width: 130,
          height: 22,
          display: "block",
          background: "transparent",
          touchAction: "none",
          borderBottom: "1px solid #111827",
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
  );
}

function InitialsImage({ value }) {
  return (
    <div style={{ marginTop: 6, marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 400, color: "#111827", marginBottom: 2 }}>
        Initials:
      </div>
      <div
        style={{
          width: "100%",
          borderBottom: "1px solid #111827",
          height: 18,
          position: "relative",
        }}
      >
        {value ? (
          <img
            src={value}
            alt="Initials"
            style={{
              position: "absolute",
              left: 0,
              bottom: 1,
              height: 15,
              objectFit: "contain",
            }}
          />
        ) : (
          <span style={{ position: "absolute", left: 0, bottom: -2, color: "#111827" }}>
            __
          </span>
        )}
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

function gradientHeader(title) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "linear-gradient(90deg, #1f7a4d, #6b46c1)",
        padding: "18px 22px",
        color: "#fff",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>CAPITAL CLAIMS GROUP</div>
    </div>
  );
}

function twoColGrid(children) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: 14,
        padding: 20,
      }}
    >
      {children}
    </div>
  );
}

function DocLabel({ children }) {
  return (
    <div
      style={{
        display: "block",
        fontSize: 10,        // ⬅️ smaller
        color: "#374151",
        marginBottom: 3,     // ⬅️ tighter spacing
        fontWeight: 400,
        lineHeight: 1.1,     // ⬅️ tighter line height
      }}
    >
      {children}
    </div>
  );
}

function DocFieldBox({ children }) {
  return (
    <div
      style={{
        minHeight: 30,                 // ⬅️ smaller box
        border: "1px solid #cbd5e1",
        borderRadius: 10,
        padding: "5px 8px",           // ⬅️ less padding
        background: "#fff",
        fontSize: 12,                 // ⬅️ smaller text
        lineHeight: 1.2,
        color: "#111827",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

function LorLabel({ children }) {
  return (
    <div
      style={{
        display: "block",
        fontSize: 16,
        color: "#4b5563",
        marginBottom: 8,
        fontWeight: 400,
      }}
    >
      {children}
    </div>
  );
}

function LorFieldBox({ children }) {
  return (
    <div
      style={{
        minHeight: 50,
        border: "1px solid #cbd5e1",
        borderRadius: 12,
        padding: "11px 14px",
        background: "#fff",
        fontSize: 15,
        lineHeight: 1.4,
        color: "#111827",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

function SignatureDisplay({ name, value, title }) {
  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: 14, fontWeight: 500 }}>
        {title}
      </div>
      <div
        style={{
          display: "flex",
          height: 150,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderRadius: 8,
          border: "1px dashed #9ca3af",
          background: "#fff",
        }}
      >
        {value ? (
          <img
            src={value}
            alt={title}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <span style={{ color: "#94a3b8", fontSize: 13 }}>
            Signature pending
          </span>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 14, color: "#374151" }}>{name}</div>
    </div>
  );
}

function LetterOfRepresentation({ data, sig1, sig2 }) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const fullAddress = formatAddress(data);
  const displayedLossLocation = data.lossLocationSameAsAddress
    ? fullAddress
    : data.lossLocation;

  return (
    <div
      id="printable-document"
      style={{
        borderRadius: 24,
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
      {gradientHeader("Letter of Representation")}

      {twoColGrid(
        <>
          <div>
            <LorLabel>Date</LorLabel>
            <LorFieldBox>{data.date}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Insurance Company</LorLabel>
            <LorFieldBox>{data.insuranceCompany}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Address</LorLabel>
            <LorFieldBox>
              <div style={{ whiteSpace: "pre-line" }}>{fullAddress}</div>
            </LorFieldBox>
          </div>

          <div>
            <LorLabel>State</LorLabel>
            <LorFieldBox>{data.state}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Claim #</LorLabel>
            <LorFieldBox>{data.claimNumber}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Client / Insured</LorLabel>
            <LorFieldBox>
              {[data.homeowner1, data.homeowner2].filter(Boolean).join(", ")}
            </LorFieldBox>
          </div>

          <div>
            <LorLabel>Loss Location</LorLabel>
            <LorFieldBox>
              <div style={{ whiteSpace: "pre-line" }}>{displayedLossLocation}</div>
            </LorFieldBox>
          </div>

          <div>
            <LorLabel>Policy #</LorLabel>
            <LorFieldBox>{data.policyNumber}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Date of Loss</LorLabel>
            <LorFieldBox>{data.dateOfLoss}</LorFieldBox>
          </div>

          <div>
            <LorLabel>Signer Email (recipient)</LorLabel>
            <LorFieldBox>{data.signerEmail}</LorFieldBox>
          </div>
        </>
      )}

      <div
        style={{
          padding: "0 24px 22px",
          color: "#111827",
          fontSize: 17,
          lineHeight: 1.6,
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div style={{ borderTop: "1px solid #9ca3af", marginBottom: 12 }} />

        <p style={{ margin: "0 0 8px", fontWeight: 400 }}>Dear Claims Manager:</p>

        <p style={{ margin: "0 0 8px" }}>
          This correspondence will serve to inform you and the Insurance Company
          that your insured has formally retained our services to assist them in
          evaluating and presenting their above-referenced claim. We have enclosed
          a copy of our signed representation notice, which we request that you
          record in your claim file and properly provide us with a written
          acknowledgment of our involvement.
        </p>

        <p style={{ margin: "0 0 8px" }}>
          Additionally, we request that all further contact and communication
          involving this claim’s processing from the Insurance Company be directed
          exclusively through our offices. This also extends to your representative
          contractor/claims agents and/or any other claims agents you may be using
          in the processing of this claim.
        </p>

        <p style={{ margin: "0 0 8px" }}>
          Further, as the policy sets forth the duties, rights, and parameters of
          coverage, it is critical that we have expedited access to this
          information, we hereby request a true and complete certified copy of the
          applicable policy contract including the declarations page, all policy
          endorsements, and the original policy application. Please expedite these
          documents to our attention.
        </p>

        <p style={{ margin: "0 0 8px", fontStyle: "italic" }}>
          Also, please note that Capital Claims Group Inc. should be named as an
          additional payee on all insurance drafts and/or payments, pursuant to the
          enclosed Notice of Loss/Notice of Representation signed by the Insured(s).
          The insured(s) hereby reserve all rights to make claims under the policy
          for replacement cost benefits as set forth in the policy and likewise
          invoke their rights to repair, rebuild or replace the damaged property.
        </p>

        <p style={{ margin: "0 0 8px" }}>
          Surely, you understand the Assured’s need to have this claim processed as
          quickly as possible, and as such, we will be undertaking all necessary
          steps to document and prepare their claim for submission. We look forward
          to working cooperatively with you to reach a fair and prompt resolution
          to this claim. Please feel free to contact us at 954-874-3563 to discuss
          the current status of this claim and to coordinate our efforts in the loss
          investigation and valuation process.
        </p>

        <p style={{ margin: "0 0 14px", fontStyle: "italic" }}>
          The Assureds hereby reserve all of their rights under the policy and the
          laws of this State and nothing contained herein is intended to waive or
          prejudice said rights.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
            gap: 20,
            paddingTop: 8,
          }}
        >
          <SignatureDisplay
            title="Insured Signature"
            name={data.homeowner1}
            value={sig1}
          />
          {hasSecond && (
            <SignatureDisplay
              title="Insured Signature"
              name={data.homeowner2}
              value={sig2}
            />
          )}
        </div>

        <div
          style={{
            borderTop: "3px solid #7c3aed",
            marginTop: 20,
            paddingTop: 12,
            fontSize: 13.5,
            color: "#111827",
            lineHeight: 1.35,
          }}
        >
          <div style={{ fontWeight: 700 }}>3600 Red Rd suite Ste 601B</div>
          <div>
            Miramar, FL 33025 • claims@capitalclaimgroup.com • +1 (954)
            571-3035 • www.ccgclaims.com
          </div>
          <div style={{ marginTop: 8, fontWeight: 700, color: "#6d28d9" }}>
            License No: G240595
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("input");
  const [activeDoc, setActiveDoc] = useState("lor");
  const [signMode, setSignMode] = useState("now");
  const [data, setData] = useState(initialData);
  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");
  const [pendingSend, setPendingSend] = useState(false);

  const saveClaimToSupabase = async () => {
    const { error } = await supabase.from("claims").insert([
      {
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
        signature1: sig1,
        signature2: sig2,
        initials1: data.initials1,
        initials2: data.initials2,
      },
    ]);

    return error;
  };

  const hasSecond = Boolean(data.homeowner2?.trim());

  const propertyAddressText = [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  useEffect(() => {
    if (data.lossLocationSameAsAddress) {
      setData((prev) => ({
        ...prev,
        lossLocation: propertyAddressText,
      }));
    }
  }, [
    data.address,
    data.city,
    data.state,
    data.zip,
    data.lossLocationSameAsAddress,
  ]);

  const update = (key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const openDoc = (doc) => {
    setActiveDoc(doc);
    setSig1("");
    setSig2("");
    setPendingSend(signMode === "send");
    setView("sign");
  };

  const submitDoc = async () => {
    const error = await saveClaimToSupabase();

if (error) {
  alert("Error saving: " + error.message);
  return;
}

const pdfBlob = await generatePDF(activeDoc);
const pdfBase64 = await blobToBase64(pdfBlob);
      
    const emailResponse = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
  to: [data.signerEmail, data.paEmail].filter(Boolean),

  subject:
    activeDoc === "lor"
      ? "Letter of Representation Submitted"
      : "PA Agreement Submitted",

  html: `
    <h2>Claim Document Submitted</h2>
    <p><strong>Document:</strong> ${
      activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"
    }</p>
    <p><strong>Insurance Company:</strong> ${data.insuranceCompany || ""}</p>
    <p><strong>Policy Number:</strong> ${data.policyNumber || ""}</p>
    <p><strong>Homeowner 1:</strong> ${data.homeowner1 || ""}</p>
    <p><strong>Homeowner 2:</strong> ${data.homeowner2 || ""}</p>
    <p><strong>Representative:</strong> ${data.representativeName || ""}</p>
  `,

  attachments: [
    {
      filename:
        activeDoc === "lor"
          ? "Letter-of-Representation.pdf"
          : "Public-Adjuster-Agreement.pdf",
      content: pdfBase64.split(",")[1],
encoding: "base64",
    },
  ],
}),
    });

    const emailResult = await emailResponse.json();

    if (!emailResponse.ok) {
      alert("Saved to database, but email failed: " + (emailResult.error || "Unknown error"));
      return;
    }

    if (pendingSend) {
      alert(
        `Saved successfully! This would send the ${
          activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"
        } to ${data.signerEmail} for signature and notify  ${data.paEmail}.`
      );
    } else {
      alert(
        `Saved successfully! This would email signed copies of the ${
          activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"
        } to ${data.signerEmail} and ${data.paEmail}.`
      );
    }

    setView("input");
    setPendingSend(false);
  };

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
        {view === "input" && (
          <Card>
            <CardHeader>
              <CardTitle>Claim Intake</CardTitle>
              <CardDescription>
                Enter the information once, choose sign now or send for signing,
                then choose the document.
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
                  <SectionTitle>Insurance Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="Date"
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

              <div
                style={{
                  marginTop: 20,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                }}
              >
                <Button onClick={() => openDoc("lor")}>
                  <FileSignature size={16} /> Letter of Representation
                </Button>

                <Button variant="outline" onClick={() => openDoc("pac")}>
                  <FileSignature size={16} /> PA Agreement
                </Button>
              </div>

              <div
                style={{
                  fontSize: 18,
                  color: "red",
                  fontWeight: "bold",
                  marginTop: 14,
                  textAlign: "center",
                }}
              >
                First pick which function sign now or send for signing then click on the form you want
              </div>
            </CardContent>
          </Card>
        )}

        {view === "sign" && (
          <>
            <div>
              <Button variant="outline" onClick={() => setView("input")}>
                <ArrowLeft size={16} /> Back
              </Button>
            </div>

            {activeDoc === "lor" ? (
              <LetterOfRepresentation data={data} sig1={sig1} sig2={sig2} />
            ) : (
              <PublicAdjusterContract
                data={data}
                sig1={sig1}
                sig2={sig2}
                onInitials1Change={(v) => update("initials1", v)}
                onInitials2Change={(v) => update("initials2", v)}
              />
            )}

            <Card>
              <CardHeader>
                <CardTitle>
                  {pendingSend ? "Review & Send for Signing" : "Sign Document"}
                </CardTitle>
                <CardDescription>
                  {pendingSend
                    ? "Review the form, then send it to the homeowner for signature."
                    : "These signatures apply to the selected document."}
                </CardDescription>
              </CardHeader>

              <CardContent>
                {!pendingSend && (
                  <>
                    <SignaturePad
                      title="Homeowner 1 Signature"
                      value={sig1}
                      onChange={setSig1}
                    />
                    {hasSecond && (
                      <SignaturePad
                        title="Homeowner 2 Signature"
                        value={sig2}
                        onChange={setSig2}
                      />
                    )}
                  </>
                )}

                <div style={{ display: "flex", gap: 12, paddingTop: 8 }}>
  <Button onClick={submitDoc}>
    {pendingSend ? <Send size={16} /> : <Mail size={16} />}
    {pendingSend ? "Send for Signing" : "Submit & Email Copies"}
  </Button>

  <Button
    variant="outline"
    onClick={async () => {
      const element = document.getElementById("printable-document");

      const opt = {
        margin: 0.1,
        filename:
          activeDoc === "lor"
            ? "Letter-of-Representation.pdf"
            : "Public-Adjuster-Agreement.pdf",
        image: { type: "jpeg", quality: 1 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      };

      await html2pdf().set(opt).from(element).save();
    }}
  >
    Download PDF
  </Button>
</div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
