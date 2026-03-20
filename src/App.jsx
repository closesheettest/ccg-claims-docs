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
        <Label>{title}</Label>
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
          border: "1px dashed #cbd5e1",
          borderRadius: 12,
          background: "#fff",
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

function LetterOfRepresentation({ data, sig1, sig2, isExportingPdf = false }) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const fullAddress = formatAddress(data);
  const displayedLossLocation = data.lossLocationSameAsAddress
    ? fullAddress
    : data.lossLocation;

  const containerStyle = isExportingPdf
    ? {
        width: "8.5in",
        background: "#fff",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }
    : {
        background: "#fff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        overflow: "hidden",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      };

  const pageStyle = (isLast = false) => ({
    width: "100%",
    minHeight: isExportingPdf ? "11in" : "auto",
    background: "#fff",
    boxSizing: "border-box",
    overflow: "hidden",
    pageBreakAfter: isExportingPdf ? (isLast ? "auto" : "always") : "auto",
  });

  const innerStyle = {
    padding: isExportingPdf ? "0 0.42in 0.14in" : "0 28px 20px",
    boxSizing: "border-box",
  };

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
      style={{ width: "100%", display: "block", marginTop: 14 }}
    />
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
    fontSize: 12,
    lineHeight: 1.55,
    color: "#111827",
  };

  const footerBlock = (
    <div
      style={{
        borderTop: "3px solid #7c3aed",
        marginTop: 16,
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
    <div id="printable-document" style={containerStyle}>
      <div className="pdf-page" style={pageStyle(false)}>
        <HeaderImg />

        <div style={innerStyle}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginTop: 10,
              marginBottom: 18,
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
                <div style={{ whiteSpace: "pre-line" }}>{displayedLossLocation}</div>
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
              Further, as the policy sets forth the duties, rights, and parameters
              of coverage, it is critical that we have expedited access to this
              information, we hereby request a true and complete certified copy of
              the applicable policy contract including the declarations page, all
              policy endorsements, and the original policy application. Please
              expedite these documents to our attention.
            </p>

            <p style={{ margin: 0, fontStyle: "italic" }}>
              Also, please note that Capital Claims Group Inc. should be named as
              an additional payee on all insurance drafts and/or payments,
              pursuant to the enclosed Notice of Loss/Notice of Representation
              signed by the Insured(s). The insured(s) hereby reserve all rights
              to make claims under the policy for replacement cost benefits as set
              forth in the policy and likewise invoke their rights to repair,
              rebuild or replace the damaged property.
            </p>
          </div>

          <FooterImg />
        </div>
      </div>

      <div className="pdf-page" style={pageStyle(true)}>
        <HeaderImg />

        <div style={innerStyle}>
          <div style={{ ...bodyText, marginTop: 10 }}>
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

                  {hasSecond && (
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
                  )}
                </div>
              ) : (
                <span style={{ color: "#94a3b8", fontSize: 12 }}>
                  Signature pending
                </span>
              )}
            </div>

            {footerBlock}
            <FooterImg />
          </div>
        </div>
      </div>
    </div>
  );
}

function PublicAdjusterContract({
  data,
  sig1,
  sig2,
  isExportingPdf = false,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const insuredNames = [data.homeowner1, data.homeowner2]
    .filter(Boolean)
    .join(", ");

  const containerStyle = isExportingPdf
    ? {
        width: "8.5in",
        background: "#fff",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }
    : {
        background: "#fff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        overflow: "hidden",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      };

  const pageStyle = (isLast = false) => ({
    width: "100%",
    minHeight: isExportingPdf ? "11in" : "auto",
    background: "#fff",
    boxSizing: "border-box",
    overflow: "hidden",
    pageBreakAfter: isExportingPdf ? (isLast ? "auto" : "always") : "auto",
  });

  const pageInnerStyle = {
    padding: isExportingPdf ? "0 0.42in 0.12in" : "0 28px 20px",
  };

  const bodyText = {
    fontSize: 12,
    lineHeight: 1.45,
    color: "#111827",
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
      style={{
        width: "100%",
        display: "block",
      }}
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
      style={{
        width: "100%",
        display: "block",
        margin: "10px 0 12px",
      }}
    />
  );

  const InitialsRow = () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
        gap: 18,
        marginTop: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 11, marginBottom: 2 }}>Initials:</div>
        <div
          style={{
            borderBottom: "1px solid #000",
            height: 20,
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          {data.initials1 ? (
            <img src={data.initials1} alt="initials 1" style={{ height: 16 }} />
          ) : (
            <span style={{ fontSize: 14 }}>__</span>
          )}
        </div>
      </div>

      {hasSecond && (
        <div>
          <div style={{ fontSize: 11, marginBottom: 2 }}>Initials:</div>
          <div
            style={{
              borderBottom: "1px solid #000",
              height: 20,
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            {data.initials2 ? (
              <img src={data.initials2} alt="initials 2" style={{ height: 16 }} />
            ) : (
              <span style={{ fontSize: 14 }}>__</span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const Footer = ({ page }) => (
    <div style={{ marginTop: 14 }}>
      {isExportingPdf && (
        <div
          style={{
            textAlign: "center",
            fontSize: 10,
            color: "#2f9e44",
            fontStyle: "italic",
            marginBottom: 4,
          }}
        >
          Page {page} of 4
        </div>
      )}
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
    <div id="printable-document" style={containerStyle}>
      <div className="pdf-page" style={pageStyle(false)}>
        <HeaderImg />
        <div style={pageInnerStyle}>
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
              assigns to Capital Claims Group <strong>10%</strong> of all
              payments made by the insurance company related to this claim. In the
              event appraisal, mediation is demanded, or a lawsuit ensues
              regarding the above-mentioned claim, there will be an additional
              charge of five percent. The total contractual percentage shall not
              exceed the maximum allowed by law.
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

          <Footer page={1} />
        </div>
      </div>

      <div className="pdf-page" style={pageStyle(false)}>
        <HeaderImg />
        <div style={pageInnerStyle}>
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
                }}
              >
                {insuredNames}
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
              }}
            >
              {data.representativeName}
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

          <Footer page={2} />
        </div>
      </div>

      <div className="pdf-page" style={pageStyle(false)}>
        <HeaderImg />
        <div style={pageInnerStyle}>
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
              11. <span style={sectionHead}>Commercial Policy Cancellation:</span>
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

          <Footer page={3} />
        </div>
      </div>

      <div className="pdf-page" style={pageStyle(true)}>
        <HeaderImg />
        <div style={pageInnerStyle}>
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
                    {sig1 && (
                      <img
                        src={sig1}
                        alt="Insured signature 1"
                        style={{ height: 30, objectFit: "contain" }}
                      />
                    )}
                  </div>
                  <div style={{ fontSize: 11 }}>Signature of the policyholder</div>
                  <div style={{ marginTop: 8 }}>Date: {data.date}</div>
                </div>

                {hasSecond && (
                  <div style={{ marginTop: 18, fontSize: 12 }}>
                    <div>Insured (Print): {data.homeowner2}</div>
                    <div style={{ marginTop: 8, minHeight: 36 }}>
                      {sig2 && (
                        <img
                          src={sig2}
                          alt="Insured signature 2"
                          style={{ height: 30, objectFit: "contain" }}
                        />
                      )}
                    </div>
                    <div style={{ fontSize: 11 }}>
                      Signature of the policyholder
                    </div>
                    <div style={{ marginTop: 8 }}>Date: {data.date}</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <Footer page={4} />
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
  const [isExportingPdf, setIsExportingPdf] = useState(false);

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
    propertyAddressText,
  ]);

  const update = (key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const openDoc = (doc) => {
    setActiveDoc(doc);
    setSig1("");
    setSig2("");
    update("initials1", "");
    update("initials2", "");
    setPendingSend(signMode === "send");
    setView("sign");
  };

  const getPrintableFilename = () =>
    activeDoc === "lor"
      ? "Letter-of-Representation.pdf"
      : "Public-Adjuster-Agreement.pdf";

  const generatePDF = async () => {
    const element = document.getElementById("printable-document");
    if (!element) {
      throw new Error("Printable document not found.");
    }

    setIsExportingPdf(true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      const opt = {
        margin: 0,
        filename: getPrintableFilename(),
        image: { type: "jpeg", quality: 1 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
        pagebreak: { mode: ["css"] },
      };

      return await html2pdf().set(opt).from(element).outputPdf("blob");
    } finally {
      setIsExportingPdf(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const savePDF = async () => {
    const element = document.getElementById("printable-document");
    if (!element) {
      alert("Document not found.");
      return;
    }

    setIsExportingPdf(true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      const opt = {
        margin: 0,
        filename: getPrintableFilename(),
        image: { type: "jpeg", quality: 1 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
        pagebreak: { mode: ["css"] },
      };

      await html2pdf().set(opt).from(element).save();
    } catch (err) {
      alert(err?.message || "Failed to download PDF.");
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

  const submitDoc = async () => {
    try {
      const error = await saveClaimToSupabase();

      if (error) {
        alert("Error saving: " + error.message);
        return;
      }

      const pdfBlob = await generatePDF();
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
              activeDoc === "lor"
                ? "Letter of Representation"
                : "PA Agreement"
            }</p>
            <p><strong>Insurance Company:</strong> ${data.insuranceCompany || ""}</p>
            <p><strong>Policy Number:</strong> ${data.policyNumber || ""}</p>
            <p><strong>Homeowner 1:</strong> ${data.homeowner1 || ""}</p>
            <p><strong>Homeowner 2:</strong> ${data.homeowner2 || ""}</p>
            <p><strong>Representative:</strong> ${data.representativeName || ""}</p>
          `,
          attachments: [
            {
              filename: getPrintableFilename(),
              content: String(pdfBase64).split(",")[1],
              encoding: "base64",
            },
          ],
        }),
      });

      const emailResult = await emailResponse.json();

      if (!emailResponse.ok) {
        alert(
          "Saved to database, but email failed: " +
            (emailResult.error || "Unknown error")
        );
        return;
      }

      if (pendingSend) {
        alert(
          `Saved successfully! This would send the ${
            activeDoc === "lor"
              ? "Letter of Representation"
              : "PA Agreement"
          } to ${data.signerEmail} for signature and notify ${data.paEmail}.`
        );
      } else {
        alert(
          `Saved successfully! This would email signed copies of the ${
            activeDoc === "lor"
              ? "Letter of Representation"
              : "PA Agreement"
          } to ${data.signerEmail} and ${data.paEmail}.`
        );
      }

      setView("input");
      setPendingSend(false);
    } catch (err) {
      alert(err?.message || "Something went wrong.");
    }
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

        .pdf-page {
          break-inside: avoid;
        }

        @media print {
          .pdf-page {
            page-break-after: always;
            break-after: page;
          }

          .pdf-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }
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
                    <FormField
                      label="Claim #"
                      value={data.claimNumber}
                      onChange={(v) => update("claimNumber", v)}
                    />
                    <FormField
                      label="Date of Loss"
                      type="date"
                      value={data.dateOfLoss}
                      onChange={(v) => update("dateOfLoss", v)}
                    />
                    <FormField
                      label="Claim Type"
                      value={data.claimType}
                      onChange={(v) => update("claimType", v)}
                    />
                    <FormField
                      label="Loss Description"
                      value={data.lossDescription}
                      onChange={(v) => update("lossDescription", v)}
                    />
                    <FormField
                      label="Situation"
                      value={data.situation}
                      onChange={(v) => update("situation", v)}
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
                First pick which function sign now or send for signing then click
                on the form you want
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
              <LetterOfRepresentation
                data={data}
                sig1={sig1}
                sig2={sig2}
                isExportingPdf={isExportingPdf}
              />
            ) : (
              <PublicAdjusterContract
                data={data}
                sig1={sig1}
                sig2={sig2}
                isExportingPdf={isExportingPdf}
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
                {activeDoc === "pac" && !pendingSend && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                      gap: 16,
                      marginBottom: 8,
                    }}
                  >
                    <InitialsPad
                      title="Homeowner 1 Initials"
                      value={data.initials1}
                      onChange={(v) => update("initials1", v)}
                    />
                    {hasSecond && (
                      <InitialsPad
                        title="Homeowner 2 Initials"
                        value={data.initials2}
                        onChange={(v) => update("initials2", v)}
                      />
                    )}
                  </div>
                )}

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

                  <Button variant="outline" onClick={savePDF}>
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