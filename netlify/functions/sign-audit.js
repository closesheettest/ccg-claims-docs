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