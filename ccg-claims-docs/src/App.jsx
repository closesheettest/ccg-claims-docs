import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, FileSignature, Mail, RotateCcw, Send } from "lucide-react";

const initialData = {
  date: "",
  insuranceCompany: "",
  policyNumber: "",
  lossLocation: "",
  signerEmail: "",
  paEmail: "claims@iambenitopaul.com",
  representativeName: "Benito Paul",
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

function FormField({ label, value, onChange, type = "text", placeholder = "", disabled = false }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm text-slate-700">{label}</Label>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-xl"
      />
    </div>
  );
}

function SignaturePad({ title, value, onChange, height = "h-40" }) {
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium text-slate-700">{title}</Label>
        <Button type="button" variant="outline" size="sm" onClick={clear}>
          <RotateCcw className="mr-2 h-4 w-4" /> Clear
        </Button>
      </div>
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-2 shadow-sm">
        <canvas
          ref={canvasRef}
          className={`${height} w-full touch-none rounded-xl bg-slate-50`}
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
  return <SignaturePad title={title} value={value} onChange={onChange} height="h-20" />;
}

function InitialsImage({ value }) {
  return (
    <div className="mt-2 flex h-16 items-center justify-center overflow-hidden rounded-xl border bg-slate-50">
      {value ? <img src={value} alt="Initials" className="h-full w-full object-contain" /> : <span>__</span>}
    </div>
  );
}

function formatAddress(data) {
  return [data.address, [data.city, data.state, data.zip].filter(Boolean).join(", ")].filter(Boolean).join("\n");
}

function LetterOfRepresentation({ data, sig1, sig2 }) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const fullAddress = formatAddress(data);

  return (
    <div className="rounded-3xl overflow-hidden border bg-white shadow-sm">
      <div className="flex items-center justify-between bg-gradient-to-r from-emerald-700 to-violet-700 px-6 py-5 text-white">
        <div className="text-2xl font-bold">Letter of Representation</div>
        <div className="text-lg font-semibold">CAPITAL CLAIMS GROUP</div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <div><Label>Date</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.date}</div></div>
        <div><Label>Insurance Company</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.insuranceCompany}</div></div>
        <div><Label>Address</Label><div className="mt-2 whitespace-pre-line rounded-xl border px-3 py-2">{fullAddress}</div></div>
        <div><Label>State</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.state}</div></div>
        <div><Label>Claim #</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.claimNumber}</div></div>
        <div><Label>Client / Insured</Label><div className="mt-2 rounded-xl border px-3 py-2">{[data.homeowner1, data.homeowner2].filter(Boolean).join(", ")}</div></div>
        <div><Label>Loss Location</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.lossLocation}</div></div>
        <div><Label>Policy #</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.policyNumber}</div></div>
        <div><Label>Date of Loss</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.dateOfLoss}</div></div>
        <div><Label>Signer Email (recipient)</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.signerEmail}</div></div>
      </div>

      <div className="space-y-4 px-6 pb-6 text-[15px] leading-8 text-slate-800">
        <Separator />
        <p><strong>Dear Claims Manager:</strong></p>
        <p>This correspondence will serve to inform you and the Insurance Company that your insured has formally retained our services to assist them in evaluating and presenting their above-referenced claim. We have enclosed a copy of our signed representation notice, which we request that you record in your claim file and properly provide us with a written acknowledgment of our involvement.</p>
        <p>Additionally, we request that all further contact and communication involving this claim’s processing from the Insurance Company be directed exclusively through our offices. This also extends to your representative contractor/claims agents and/or any other claims agents you may be using in the processing of this claim.</p>
        <p>Further, as the policy sets forth the duties, rights, and parameters of coverage, it is critical that we have expedited access to this information, we hereby request a true and complete certified copy of the applicable policy contract including the declarations page, all policy endorsements, and the original policy application. Please expedite these documents to our attention.</p>
        <p className="italic">Also, please note that Capital Claims Group Inc. should be named as an additional payee on all insurance drafts and/or payments, pursuant to the enclosed Notice of Loss/Notice of Representation signed by the Insured(s). The insured(s) hereby reserve all rights to make claims under the policy for replacement cost benefits as set forth in the policy and likewise invoke their rights to repair, rebuild or replace the damaged property.</p>
        <p>Surely, you understand the Assured’s need to have this claim processed as quickly as possible, and as such, we will be undertaking all necessary steps to document and prepare their claim for submission. We look forward to working cooperatively with you to reach a fair and prompt resolution to this claim.</p>
        <p className="italic">The Assureds hereby reserve all of their rights under the policy and the laws of this State and nothing contained herein is intended to waive or prejudice said rights.</p>

        <div className={`grid gap-6 pt-4 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
          <div>
            <div className="mb-2 text-sm font-medium">Homeowner 1 Signature</div>
            <div className="flex h-40 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-slate-50">{sig1 ? <img src={sig1} alt="Signature 1" className="h-full w-full object-contain" /> : <span className="text-sm text-slate-400">Signature pending</span>}</div>
            <div className="mt-2 text-sm text-slate-600">{data.homeowner1}</div>
          </div>
          {hasSecond && (
            <div>
              <div className="mb-2 text-sm font-medium">Homeowner 2 Signature</div>
              <div className="flex h-40 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-slate-50">{sig2 ? <img src={sig2} alt="Signature 2" className="h-full w-full object-contain" /> : <span className="text-sm text-slate-400">Signature pending</span>}</div>
              <div className="mt-2 text-sm text-slate-600">{data.homeowner2}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PublicAdjusterContract({ data, sig1, sig2, onInitials1Change, onInitials2Change }) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const insuredNames = [data.homeowner1, data.homeowner2].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      <div className="rounded-3xl overflow-hidden border bg-white shadow-sm">
        <div className="flex items-center justify-between bg-gradient-to-r from-emerald-700 to-violet-700 px-6 py-5 text-white">
          <div className="text-2xl font-bold">Public Adjuster Contract</div>
          <div className="text-lg font-semibold">CAPITAL CLAIMS GROUP</div>
        </div>

        <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
          <div><Label>Insured Name(s)</Label><div className="mt-2 rounded-xl border px-3 py-2">{insuredNames}</div></div>
          <div><Label>Loss Description</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.lossDescription}</div></div>
          <div><Label>Claim Type</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.claimType}</div></div>
          <div><Label>Situation</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.situation}</div></div>
          <div><Label>Phone</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.phone}</div></div>
          <div><Label>Insurer</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.insuranceCompany}</div></div>
          <div><Label>Date of Loss</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.dateOfLoss}</div></div>
          <div><Label>Policy #</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.policyNumber}</div></div>
          <div><Label>Claim #</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.claimNumber}</div></div>
          <div><Label>Street Address</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.address}</div></div>
          <div><Label>City</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.city}</div></div>
          <div><Label>State</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.state}</div></div>
          <div><Label>ZIP</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.zip}</div></div>
          <div className="md:col-span-2"><Label>Signer Email (recipient)</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.signerEmail}</div></div>
        </div>

        <div className="space-y-5 px-6 pb-6 text-[15px] leading-7 text-slate-800">
          <div className="rounded-xl bg-slate-100 px-4 py-3 font-bold">PUBLIC ADJUSTER CONTRACT</div>

          <p><strong>1. SERVICE FEE:</strong> The insured(s) hereby retains Capital Claims Group to be its public adjuster and hereby appoints Capital Claims Group to be its independent appraiser to appraise, advise, negotiate, and/or settle the above-referenced claim. The insured(s) agrees to pay and hereby assigns to Capital Claims Group 10% of all payments made by the insurance company related to this claim. In the event appraisal, mediation is demanded, or a lawsuit ensues regarding the above-mentioned claim, there will be an additional charge of five percent. The total contractual percentage shall not exceed the maximum allowed by law.</p>

          <p><strong>2. ADDITIONAL PAYEE:</strong> The insured authorizes and requests the insurer and the insured’s mortgage carrier to have Capital Claims Group appear as an additional payee on all checks issued regarding the above-mentioned claim. The insured hereby grants Capital Claims Group a lien on recovered proceeds received by the insurer to the extent of the fee due to Capital Claims Group pursuant to this agreement.</p>

          <p><strong>3. THIRD-PARTY FEES:</strong> The insured understands it may be necessary to incur professional fees on the insured’s behalf to properly adjust the claim. These fees may include, but are not limited to, a General Contractor, Engineer, Claim Appraiser, Plumber, Roofer, and Environmental Hygienist. The insured understands that no professional fees will be incurred without the insured’s written or verbal authorization, and that the insured may then be responsible for such fees.</p>

          <div className={`grid gap-4 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
            <InitialsPad title="Initials – Homeowner 1" value={data.initials1} onChange={onInitials1Change} />
            {hasSecond && <InitialsPad title="Initials – Homeowner 2" value={data.initials2} onChange={onInitials2Change} />}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border bg-white px-6 py-8 shadow-sm text-[15px] leading-7 text-slate-800 space-y-5">
        <p><strong>4. ENDORSEMENT:</strong> The insured’s endorsement on any insurance proceeds check will be deemed to be an agreement with the terms and conditions of any related settlement regarding the above-mentioned claim.</p>

        <p><strong>5. AFFIDAVIT:</strong> I, <span className="inline-block min-w-[220px] border-b border-slate-700 px-1">{insuredNames || "Named insured"}</span>, a named insured under the above-mentioned policy, hereby swear and attest that I have the authority to enter into this contract and settle all claims issued on behalf of all named insureds. Insured acknowledges, understands, and agrees that under section 626.8796, Florida Statutes, an agreement with a public adjuster must be signed by all named insureds.</p>

        <p><strong>6. LEGAL:</strong> Capital Claims Group is not a law firm and does not offer legal advice, and there will be no attorney-client relationship with the insured(s). The insured is hereby advised of the right to counsel and may consult with an attorney regarding their claim independently of Capital Claims Group.</p>

        <p><strong>7. LETTER OF PROTECTION:</strong> The insured understands and agrees that if it becomes necessary to retain an attorney, the insured authorizes and agrees to a Letter of Protection for Capital Claims Group.</p>

        <p><strong>8. REPRESENTATION:</strong> The insured hereby affirms that no other claim(s) have been filed in reference to the same peril and that no other legal representation is involved with the claim other than <span className="inline-block min-w-[220px] border-b border-slate-700 px-1">{data.representativeName}</span>.</p>

        <div className={`grid gap-4 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
          <div>
            <div className="text-sm font-medium">Initials – Homeowner 1</div>
            <InitialsImage value={data.initials1} />
          </div>
          {hasSecond && (
            <div>
              <div className="text-sm font-medium">Initials – Homeowner 2</div>
              <InitialsImage value={data.initials2} />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-3xl border bg-white px-6 py-8 shadow-sm text-[15px] leading-7 text-slate-800 space-y-5">
        <p><strong>9. SEVERABILITY:</strong> Unenforceability or invalidity of one or more clauses in this Agreement shall not affect any other clause.</p>

        <p><strong>10. DISPUTE:</strong> In the event of litigation arising from this agreement, the venue shall be in Miami-Dade County, Florida. The prevailing party shall be entitled to recover its court costs, reasonable attorney fees, including those incurred during any appeal proceedings, and interest on any past due fees at the maximum rate permitted by applicable law.</p>

        <p><strong>11. COMMERCIAL POLICY CANCELLATION:</strong> You, the insured(s), may cancel this contract for any reason without penalty or obligation to you within 10 days after the date of this contract.</p>

        <div className={`grid gap-4 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
          <div>
            <div className="text-sm font-medium">Initials – Homeowner 1</div>
            <InitialsImage value={data.initials1} />
          </div>
          {hasSecond && (
            <div>
              <div className="text-sm font-medium">Initials – Homeowner 2</div>
              <InitialsImage value={data.initials2} />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-3xl border bg-white px-6 py-8 shadow-sm text-[15px] leading-7 text-slate-800 space-y-5">
        <p><strong>12. RESIDENTIAL POLICY CANCELLATION:</strong> You, the insured, may cancel this contract for any reason without penalty or obligation to you within 10 days after the date of this contract.</p>

        <p className="font-semibold">The notice of cancellation shall be provided to Capital Claims Group, submitted in writing, and sent by certified mail, return receipt requested, or another form of mailing that provides proof thereof, at the address specified in the contract.</p>

        <p className="font-semibold">Pursuant to s. 817.234, Florida Statutes, any person who, with the intent to injure, defraud, or deceive any insurer or insured, prepares, presents, or causes to be presented a proof of loss or estimate of cost or repair of damaged property in support of a claim under an insurance policy, knowing that the proof of loss or estimate of claim or repairs contains any false, incomplete, or misleading information concerning any fact or thing material to the claim, commits a felony of the third degree, punishable as provided in s. 775.082, s. 775.803, or s. 775.084, Florida Statutes.</p>

        <p className="font-semibold">Insured(s) have read, understand and voluntarily sign the foregoing Agreement. A computer or faxed signature or copy of this document shall be deemed to have the same effect as the original.</p>

        <div className={`grid gap-4 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
          <div>
            <div className="text-sm font-medium">Initials – Homeowner 1</div>
            <InitialsImage value={data.initials1} />
          </div>
          {hasSecond && (
            <div>
              <div className="text-sm font-medium">Initials – Homeowner 2</div>
              <InitialsImage value={data.initials2} />
            </div>
          )}
        </div>

        <div className="rounded-xl bg-slate-100 px-4 py-3 font-bold">Insured Signature</div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div><Label>Insured (Print)</Label><div className="mt-2 rounded-xl border px-3 py-2">{insuredNames}</div></div>
          <div><Label>Date</Label><div className="mt-2 rounded-xl border px-3 py-2">{data.date}</div></div>
        </div>

        <div className={`grid gap-6 pt-2 ${hasSecond ? "md:grid-cols-2" : "md:grid-cols-1"}`}>
          <div>
            <div className="mb-2 text-sm font-medium">Homeowner 1 Signature</div>
            <div className="flex h-40 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-slate-50">{sig1 ? <img src={sig1} alt="Signature 1" className="h-full w-full object-contain" /> : <span className="text-sm text-slate-400">Signature pending</span>}</div>
            <div className="mt-2 text-sm text-slate-600">{data.homeowner1}</div>
          </div>
          {hasSecond && (
            <div>
              <div className="mb-2 text-sm font-medium">Homeowner 2 Signature</div>
              <div className="flex h-40 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-slate-50">{sig2 ? <img src={sig2} alt="Signature 2" className="h-full w-full object-contain" /> : <span className="text-sm text-slate-400">Signature pending</span>}</div>
              <div className="mt-2 text-sm text-slate-600">{data.homeowner2}</div>
            </div>
          )}
        </div>

        <Separator className="border-violet-500" />
        <div className="text-sm text-slate-700">
          <div className="font-semibold">3600 Red Rd suite Ste 601B</div>
          <div>Miramar, FL 33025 &nbsp; • &nbsp; claims@capitalclaimgroup.com &nbsp; • &nbsp; +1 (954) 571-3035 &nbsp; • &nbsp; www.ccgclaims.com</div>
          <div className="mt-2 font-medium text-violet-700">License No: G240595</div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("input");
  const [activeDoc, setActiveDoc] = useState("lor");
  const [signMode, setSignMode] = useState("now");
  const [pendingSend, setPendingSend] = useState(false);
  const [data, setData] = useState(initialData);
  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");

  const hasSecond = Boolean(data.homeowner2?.trim());

  const update = (key, value) => setData((prev) => ({ ...prev, [key]: value }));

  const openDoc = (doc) => {
    setActiveDoc(doc);
    setSig1("");
    setSig2("");
    setPendingSend(signMode === "send");
    setView("sign");
  };

  const submitDoc = () => {
    if (pendingSend) {
      alert(`This would send the ${activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"} to ${data.signerEmail} for signature and send a copy/notification to ${data.paEmail}.`);
    } else {
      alert(`This would email copies of the ${activeDoc === "lor" ? "Letter of Representation" : "PA Agreement"} to ${data.signerEmail} and ${data.paEmail}.`);
    }
    setView("input");
    setPendingSend(false);
  };

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {view === "input" && (
          <Card className="rounded-3xl border-0 shadow-sm">
            <CardHeader>
              <CardTitle className="text-2xl">Claim Intake</CardTitle>
              <CardDescription>Enter the information once, choose sign now or send for signing, then choose the document.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField label="Date" type="date" value={data.date} onChange={(v) => update("date", v)} />
                <FormField label="Insurance Company" value={data.insuranceCompany} onChange={(v) => update("insuranceCompany", v)} />
                <FormField label="Policy #" value={data.policyNumber} onChange={(v) => update("policyNumber", v)} />
                <FormField label="Phone" value={data.phone} onChange={(v) => update("phone", v)} />
                <FormField label="Representative Name" value={data.representativeName} onChange={(v) => update("representativeName", v)} />
                <FormField label="Homeowner 1" value={data.homeowner1} onChange={(v) => update("homeowner1", v)} />
                <FormField label="Homeowner 2" value={data.homeowner2} onChange={(v) => update("homeowner2", v)} />
                <div className="md:col-span-2"><FormField label="Address" value={data.address} onChange={(v) => update("address", v)} /></div>
                <FormField label="City" value={data.city} onChange={(v) => update("city", v)} />
                <FormField label="State" value={data.state} onChange={(v) => update("state", v)} />
                <FormField label="ZIP" value={data.zip} onChange={(v) => update("zip", v)} />
                <div className="md:col-span-2"><FormField label="Loss Location" value={data.lossLocation} onChange={(v) => update("lossLocation", v)} /></div>
                <FormField label="Homeowner Email" type="email" value={data.signerEmail} onChange={(v) => update("signerEmail", v)} />
                <FormField label="PA Email" type="email" value={data.paEmail} onChange={(v) => update("paEmail", v)} />
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="text-sm font-medium text-slate-700">Signing option</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Button variant={signMode === "now" ? "default" : "outline"} className="rounded-2xl" onClick={() => setSignMode("now")}>
                    <FileSignature className="mr-2 h-4 w-4" /> Sign Now
                  </Button>
                  <Button variant={signMode === "send" ? "default" : "outline"} className="rounded-2xl" onClick={() => setSignMode("send")}>
                    <Send className="mr-2 h-4 w-4" /> Send for Signing
                  </Button>
                </div>
                <div className="text-xs text-slate-500">
                  Both options open the form for review first. Then the rep can either sign now in-app or send it out for signature from the document screen.
                </div>
              </div>

              <Separator />

              <div className="grid gap-3 md:grid-cols-2">
                <Button className="rounded-2xl" onClick={() => openDoc("lor")}>
                  <FileSignature className="mr-2 h-4 w-4" /> Letter of Representation
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => openDoc("pac")}>
                  <FileSignature className="mr-2 h-4 w-4" /> PA Agreement
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {view === "sign" && (
          <>
            <Button variant="outline" className="rounded-2xl" onClick={() => setView("input")}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>

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

            <Card className="rounded-3xl border-0 shadow-sm">
              <CardHeader>
                <CardTitle className="text-2xl">{pendingSend ? "Review & Send for Signing" : "Sign Document"}</CardTitle>
                <CardDescription>{pendingSend ? "Review the form, then send it to the homeowner for signature." : "These signatures apply to the selected document."}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!pendingSend && (
                  <>
                    <SignaturePad title="Homeowner 1 Signature" value={sig1} onChange={setSig1} />
                    {hasSecond && <SignaturePad title="Homeowner 2 Signature" value={sig2} onChange={setSig2} />}
                  </>
                )}
                <div className="flex flex-wrap gap-3 pt-2">
                  <Button className="rounded-2xl" onClick={submitDoc}>
                    {pendingSend ? <Send className="mr-2 h-4 w-4" /> : <Mail className="mr-2 h-4 w-4" />}
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
