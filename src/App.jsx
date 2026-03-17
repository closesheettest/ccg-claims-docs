import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSignature,
  Mail,
  RotateCcw,
  Send,
} from "lucide-react";

const initialData = {
  date: "",
  insuranceCompany: "",
  policyNumber: "",
  lossLocation: "",
  lossLocationSameAsAddress: true,
  signerEmail: "",
  paEmail: "claims@iambenitopaul.com",
  representativeName: "",
  representativeEmail: "",
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
  return (
    <SignaturePad
      title={title}
      value={value}
      onChange={onChange}
      height={80}
    />
  );
}

function InitialsImage({ value }) {
  return (
    <div
      style={{
        marginTop: 8,
        height: 64,
        border: "1px solid #d1d5db",
        borderRadius: 12,
        background: "#f8fafc",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {value ? (
        <img
          src={value}
          alt="Initials"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <span>__</span>
      )}
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
        padding: "20px 24px",
        color: "#fff",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
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
        gap: 16,
        padding: 24,
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
          height: 160,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderRadius: 16,
          border: "1px dashed #cbd5e1",
          background: "#f8fafc",
        }}
      >
        {value ? (
          <img
            src={value}
            alt={title}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <span style={{ color: "#94a3b8", fontSize: 14 }}>
            Signature pending
          </span>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 14, color: "#475569" }}>{name}</div>
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
            <Label>Date</Label>
            <FieldBox>{data.date}</FieldBox>
          </div>
          <div>
            <Label>Insurance Company</Label>
            <FieldBox>{data.insuranceCompany}</FieldBox>
          </div>
          <div>
            <Label>Address</Label>
            <FieldBox>
              <div style={{ whiteSpace: "pre-line" }}>{fullAddress}</div>
            </FieldBox>
          </div>
          <div>
            <Label>State</Label>
            <FieldBox>{data.state}</FieldBox>
          </div>
          <div>
            <Label>Claim #</Label>
            <FieldBox>{data.claimNumber}</FieldBox>
          </div>
          <div>
            <Label>Client / Insured</Label>
            <FieldBox>
              {[data.homeowner1, data.homeowner2].filter(Boolean).join(", ")}
            </FieldBox>
          </div>
          <div>
            <Label>Loss Location</Label>
            <FieldBox>
              <div style={{ whiteSpace: "pre-line" }}>{displayedLossLocation}</div>
            </FieldBox>
          </div>
          <div>
            <Label>Policy #</Label>
            <FieldBox>{data.policyNumber}</FieldBox>
          </div>
          <div>
            <Label>Date of Loss</Label>
            <FieldBox>{data.dateOfLoss}</FieldBox>
          </div>
          <div>
            <Label>Signer Email (recipient)</Label>
            <FieldBox>{data.signerEmail}</FieldBox>
          </div>
        </>
      )}

      <div
        style={{
          padding: "0 24px 24px",
          color: "#1f2937",
          fontSize: 15,
          lineHeight: 1.9,
        }}
      >
        <Separator />
        <p>
          <strong>Dear Claims Manager:</strong>
        </p>
        <p>
          This correspondence will serve to inform you and the Insurance Company
          that your insured has formally retained our services to assist them in
          evaluating and presenting their above-referenced claim. We have enclosed
          a copy of our signed representation notice, which we request that you
          record in your claim file and properly provide us with a written
          acknowledgment of our involvement.
        </p>
        <p>
          Additionally, we request that all further contact and communication
          involving this claim’s processing from the Insurance Company be directed
          exclusively through our offices. This also extends to your representative
          contractor/claims agents and/or any other claims agents you may be using
          in the processing of this claim.
        </p>
        <p>
          Further, as the policy sets forth the duties, rights, and parameters of
          coverage, it is critical that we have expedited access to this
          information, we hereby request a true and complete certified copy of the
          applicable policy contract including the declarations page, all policy
          endorsements, and the original policy application. Please expedite these
          documents to our attention.
        </p>
        <p style={{ fontStyle: "italic" }}>
          Also, please note that Capital Claims Group Inc. should be named as an
          additional payee on all insurance drafts and/or payments, pursuant to the
          enclosed Notice of Loss/Notice of Representation signed by the Insured(s).
          The insured(s) hereby reserve all rights to make claims under the policy
          for replacement cost benefits as set forth in the policy and likewise
          invoke their rights to repair, rebuild or replace the damaged property.
        </p>
        <p>
          Surely, you understand the Assured’s need to have this claim processed as
          quickly as possible, and as such, we will be undertaking all necessary
          steps to document and prepare their claim for submission. We look forward
          to working cooperatively with you to reach a fair and prompt resolution
          to this claim.
        </p>
        <p style={{ fontStyle: "italic" }}>
          The Assureds hereby reserve all of their rights under the policy and the
          laws of this State and nothing contained herein is intended to waive or
          prejudice said rights.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
            gap: 24,
            paddingTop: 16,
          }}
        >
          <SignatureDisplay
            title="Homeowner 1 Signature"
            name={data.homeowner1}
            value={sig1}
          />
          {hasSecond && (
            <SignatureDisplay
              title="Homeowner 2 Signature"
              name={data.homeowner2}
              value={sig2}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PublicAdjusterContract({
  data,
  sig1,
  sig2,
  onInitials1Change,
  onInitials2Change,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const insuredNames = [data.homeowner1, data.homeowner2].filter(Boolean).join(
    ", "
  );

  return (
    <div style={{ display: "grid", gap: 24 }}>
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
        {gradientHeader("Public Adjuster Contract")}

        {twoColGrid(
          <>
            <div>
              <Label>Insured Name(s)</Label>
              <FieldBox>{insuredNames}</FieldBox>
            </div>
            <div>
              <Label>Loss Description</Label>
              <FieldBox>{data.lossDescription}</FieldBox>
            </div>
            <div>
              <Label>Claim Type</Label>
              <FieldBox>{data.claimType}</FieldBox>
            </div>
            <div>
              <Label>Situation</Label>
              <FieldBox>{data.situation}</FieldBox>
            </div>
            <div>
              <Label>Phone</Label>
              <FieldBox>{data.phone}</FieldBox>
            </div>
            <div>
              <Label>Insurer</Label>
              <FieldBox>{data.insuranceCompany}</FieldBox>
            </div>
            <div>
              <Label>Date of Loss</Label>
              <FieldBox>{data.dateOfLoss}</FieldBox>
            </div>
            <div>
              <Label>Policy #</Label>
              <FieldBox>{data.policyNumber}</FieldBox>
            </div>
            <div>
              <Label>Claim #</Label>
              <FieldBox>{data.claimNumber}</FieldBox>
            </div>
            <div>
              <Label>Street Address</Label>
              <FieldBox>{data.address}</FieldBox>
            </div>
            <div>
              <Label>City</Label>
              <FieldBox>{data.city}</FieldBox>
            </div>
            <div>
              <Label>State</Label>
              <FieldBox>{data.state}</FieldBox>
            </div>
            <div>
              <Label>ZIP</Label>
              <FieldBox>{data.zip}</FieldBox>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <Label>Signer Email (recipient)</Label>
              <FieldBox>{data.signerEmail}</FieldBox>
            </div>
          </>
        )}

        <div
          style={{
            padding: "0 24px 24px",
            color: "#1f2937",
            fontSize: 15,
            lineHeight: 1.7,
          }}
        >
          <div
            style={{
              borderRadius: 12,
              background: "#f3f4f6",
              padding: "12px 16px",
              fontWeight: 700,
              marginBottom: 20,
            }}
          >
            PUBLIC ADJUSTER CONTRACT
          </div>

          <p>
            <strong>1. SERVICE FEE:</strong> The insured(s) hereby retains Capital
            Claims Group to be its public adjuster and hereby appoints Capital Claims
            Group to be its independent appraiser to appraise, advise, negotiate,
            and/or settle the above-referenced claim. The insured(s) agrees to pay and
            hereby assigns to Capital Claims Group 10% of all payments made by the
            insurance company related to this claim. In the event appraisal, mediation
            is demanded, or a lawsuit ensues regarding the above-mentioned claim, there
            will be an additional charge of five percent. The total contractual
            percentage shall not exceed the maximum allowed by law.
          </p>

          <p>
            <strong>2. ADDITIONAL PAYEE:</strong> The insured authorizes and requests
            the insurer and the insured’s mortgage carrier to have Capital Claims Group
            appear as an additional payee on all checks issued regarding the
            above-mentioned claim. The insured hereby grants Capital Claims Group a
            lien on recovered proceeds received by the insurer to the extent of the fee
            due to Capital Claims Group pursuant to this agreement.
          </p>

          <p>
            <strong>3. THIRD-PARTY FEES:</strong> The insured understands it may be
            necessary to incur professional fees on the insured’s behalf to properly
            adjust the claim. These fees may include, but are not limited to, a General
            Contractor, Engineer, Claim Appraiser, Plumber, Roofer, and Environmental
            Hygienist. The insured understands that no professional fees will be
            incurred without the insured’s written or verbal authorization, and that
            the insured may then be responsible for such fees.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
              gap: 24,
            }}
          >
            <InitialsPad
              title="Initials – Homeowner 1"
              value={data.initials1}
              onChange={onInitials1Change}
            />
            {hasSecond && (
              <InitialsPad
                title="Initials – Homeowner 2"
                value={data.initials2}
                onChange={onInitials2Change}
              />
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardContent>
          <div style={{ color: "#1f2937", fontSize: 15, lineHeight: 1.8 }}>
            <p>
              <strong>4. ENDORSEMENT:</strong> The insured’s endorsement on any
              insurance proceeds check will be deemed to be an agreement with the terms
              and conditions of any related settlement regarding the above-mentioned
              claim.
            </p>

            <p>
              <strong>5. AFFIDAVIT:</strong> I,{" "}
              <span
                style={{
                  display: "inline-block",
                  minWidth: 220,
                  borderBottom: "1px solid #334155",
                  padding: "0 4px",
                }}
              >
                {insuredNames || "Named insured"}
              </span>
              , a named insured under the above-mentioned policy, hereby swear and
              attest that I have the authority to enter into this contract and settle
              all claims issued on behalf of all named insureds. Insured acknowledges,
              understands, and agrees that under section 626.8796, Florida Statutes, an
              agreement with a public adjuster must be signed by all named insureds.
            </p>

            <p>
              <strong>6. LEGAL:</strong> Capital Claims Group is not a law firm and
              does not offer legal advice, and there will be no attorney-client
              relationship with the insured(s). The insured is hereby advised of the
              right to counsel and may consult with an attorney regarding their claim
              independently of Capital Claims Group.
            </p>

            <p>
              <strong>7. LETTER OF PROTECTION:</strong> The insured understands and
              agrees that if it becomes necessary to retain an attorney, the insured
              authorizes and agrees to a Letter of Protection for Capital Claims Group.
            </p>

            <p>
              <strong>8. REPRESENTATION:</strong> The insured hereby affirms that no
              other claim(s) have been filed in reference to the same peril and that no
              other legal representation is involved with the claim other than{" "}
              <span
                style={{
                  display: "inline-block",
                  minWidth: 220,
                  borderBottom: "1px solid #334155",
                  padding: "0 4px",
                }}
              >
                {data.representativeName}
              </span>
              .
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                gap: 24,
                marginTop: 16,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  Initials – Homeowner 1
                </div>
                <InitialsImage value={data.initials1} />
              </div>
              {hasSecond && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    Initials – Homeowner 2
                  </div>
                  <InitialsImage value={data.initials2} />
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div style={{ color: "#1f2937", fontSize: 15, lineHeight: 1.8 }}>
            <p>
              <strong>9. SEVERABILITY:</strong> Unenforceability or invalidity of one
              or more clauses in this Agreement shall not affect any other clause.
            </p>

            <p>
              <strong>10. DISPUTE:</strong> In the event of litigation arising from
              this agreement, the venue shall be in Miami-Dade County, Florida. The
              prevailing party shall be entitled to recover its court costs,
              reasonable attorney fees, including those incurred during any appeal
              proceedings, and interest on any past due fees at the maximum rate
              permitted by applicable law.
            </p>

            <p>
              <strong>11. COMMERCIAL POLICY CANCELLATION:</strong> You, the insured(s),
              may cancel this contract for any reason without penalty or obligation to
              you within 10 days after the date of this contract.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                gap: 24,
                marginTop: 16,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  Initials – Homeowner 1
                </div>
                <InitialsImage value={data.initials1} />
              </div>
              {hasSecond && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    Initials – Homeowner 2
                  </div>
                  <InitialsImage value={data.initials2} />
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div style={{ color: "#1f2937", fontSize: 15, lineHeight: 1.8 }}>
            <p>
              <strong>12. RESIDENTIAL POLICY CANCELLATION:</strong> You, the insured,
              may cancel this contract for any reason without penalty or obligation to
              you within 10 days after the date of this contract.
            </p>

            <p style={{ fontWeight: 600 }}>
              The notice of cancellation shall be provided to Capital Claims Group,
              submitted in writing, and sent by certified mail, return receipt
              requested, or another form of mailing that provides proof thereof, at the
              address specified in the contract.
            </p>

            <p style={{ fontWeight: 600 }}>
              Pursuant to s. 817.234, Florida Statutes, any person who, with the intent
              to injure, defraud, or deceive any insurer or insured, prepares,
              presents, or causes to be presented a proof of loss or estimate of cost
              or repair of damaged property in support of a claim under an insurance
              policy, knowing that the proof of loss or estimate of claim or repairs
              contains any false, incomplete, or misleading information concerning any
              fact or thing material to the claim, commits a felony of the third
              degree, punishable as provided in s. 775.082, s. 775.803, or s. 775.084,
              Florida Statutes.
            </p>

            <p style={{ fontWeight: 600 }}>
              Insured(s) have read, understand and voluntarily sign the foregoing
              Agreement. A computer or faxed signature or copy of this document shall
              be deemed to have the same effect as the original.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                gap: 24,
                marginTop: 16,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  Initials – Homeowner 1
                </div>
                <InitialsImage value={data.initials1} />
              </div>
              {hasSecond && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    Initials – Homeowner 2
                  </div>
                  <InitialsImage value={data.initials2} />
                </div>
              )}
            </div>

            <div
              style={{
                borderRadius: 12,
                background: "#f3f4f6",
                padding: "12px 16px",
                fontWeight: 700,
                marginTop: 24,
              }}
            >
              Insured Signature
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 16,
                marginTop: 16,
              }}
            >
              <div>
                <Label>Insured (Print)</Label>
                <FieldBox>{insuredNames}</FieldBox>
              </div>
              <div>
                <Label>Date</Label>
                <FieldBox>{data.date}</FieldBox>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                gap: 24,
                paddingTop: 16,
              }}
            >
              <SignatureDisplay
                title="Homeowner 1 Signature"
                name={data.homeowner1}
                value={sig1}
              />
              {hasSecond && (
                <SignatureDisplay
                  title="Homeowner 2 Signature"
                  name={data.homeowner2}
                  value={sig2}
                />
              )}
            </div>

            <div
              style={{
                borderTop: "3px solid #7c3aed",
                marginTop: 24,
                paddingTop: 16,
                fontSize: 14,
                color: "#374151",
              }}
            >
              <div style={{ fontWeight: 700 }}>3600 Red Rd suite Ste 601B</div>
              <div>
                Miramar, FL 33025 • claims@capitalclaimgroup.com • +1 (954)
                571-3035 • www.ccgclaims.com
              </div>
              <div style={{ marginTop: 8, fontWeight: 600, color: "#7c3aed" }}>
                License No: G240595
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
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
  }, [data.address, data.city, data.state, data.zip, data.lossLocationSameAsAddress]);

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

  const submitDoc = () => {
    if (pendingSend) {
      alert(
        `This would send the ${
          activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"
        } to ${data.signerEmail} for signature and notify ${data.representativeEmail || "the representative"} and ${data.paEmail}.`
      );
    } else {
      alert(
        `This would email signed copies of the ${
          activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"
        } to ${data.signerEmail}, ${data.representativeEmail || "the representative"}, and ${data.paEmail}.`
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
                      label="Representative Email"
                      type="email"
                      value={data.representativeEmail}
                      onChange={(v) => update("representativeEmail", v)}
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

                <div
                  style={{
                    fontSize: 12,
                    color: "#6b7280",
                    marginTop: 10,
                  }}
                >
                  Both options open the form for review first. Then the rep can
                  either sign now in-app or send it out for signature from the
                  document screen.
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
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
