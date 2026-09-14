// Ficha de un CFDI (Fase 9) — GET .../cfdi/:invoiceId (cfdi.ts, `serializeInvoice`):
// el resultado completo de `validarCfdiDespachos()` (issues/warnings/DIOT), no solo
// el resumen de la lista.
import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchInvoice } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const CATEGORIA_LABELS: Record<InvoiceSummary["categoria"], string> = {
  gasto_operativo: "Gasto operativo",
  activo_fijo: "Activo fijo",
  inversion: "Inversión",
  honorarios: "Honorarios",
  nomina: "Nómina",
  sin_clasificar: "Sin clasificar",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 14, color: "#111827" }}>{value}</div>
    </div>
  );
}

export function CfdiDetallePage({ apiBaseUrl, token, propertyId, orgSlug }: DespachosShellContext) {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const [invoice, setInvoice] = useState<InvoiceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoiceId) return;
    let cancelado = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const inv = await fetchInvoice(fetch, apiBaseUrl, token, propertyId, invoiceId);
        if (!cancelado) setInvoice(inv);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el CFDI.");
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, invoiceId]);

  if (!invoiceId) return <p role="alert">CFDI no especificado.</p>;
  if (loading && !invoice) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (error) return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  if (!invoice) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <Link to={`/despachos/${orgSlug}/cfdi`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← CFDI
        </Link>
      </div>

      <header>
        <h1 style={{ fontSize: 18, margin: 0, fontFamily: "monospace" }}>{invoice.folioFiscal}</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          {invoice.valido ? "Válido" : "Con hallazgos"} {invoice.requiereRevisionHumana && "· Requiere revisión humana"}
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <Field label="RFC emisor" value={invoice.rfcEmisor} />
        <Field label="Emisor" value={invoice.emisorNombre ?? "—"} />
        <Field label="RFC receptor" value={invoice.rfcReceptor} />
        <Field label="Subtotal" value={formatMoney(invoice.subtotal)} />
        <Field label="IVA" value={formatMoney(invoice.iva)} />
        <Field label="Descuento" value={formatMoney(invoice.descuento)} />
        <Field label="Total" value={formatMoney(invoice.total)} />
        <Field label="Categoría" value={CATEGORIA_LABELS[invoice.categoria] ?? invoice.categoria} />
        <Field label="Ingestado" value={formatDate(invoice.creadoEn)} />
      </div>

      {invoice.issues.length > 0 && (
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Hallazgos</h2>
          <ul style={{ margin: 0, paddingLeft: 18, color: "#b91c1c", fontSize: 13 }}>
            {invoice.issues.map((i, idx) => (
              <li key={`${i.codigo}-${idx}`}>
                <strong>{i.codigo}</strong>: {i.mensaje}
              </li>
            ))}
          </ul>
        </div>
      )}

      {invoice.warnings.length > 0 && (
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Advertencias</h2>
          <ul style={{ margin: 0, paddingLeft: 18, color: "#92400e", fontSize: 13 }}>
            {invoice.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>DIOT</h2>
        <p style={{ fontSize: 13, color: "#374151", margin: 0 }}>
          {invoice.diot.reportable ? `Reportable — ${invoice.diot.proveedoresReportables.length} proveedor(es)` : "No reportable"}
        </p>
      </div>
    </div>
  );
}
