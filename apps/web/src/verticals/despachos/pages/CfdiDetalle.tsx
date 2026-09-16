// Ficha de un CFDI (Fase 9) — GET .../cfdi/:invoiceId (cfdi.ts, `serializeInvoice`):
// el resultado completo de `validarCfdiDespachos()` (issues/warnings/DIOT), no solo
// el resumen de la lista.
import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { EstadoCargando, EstadoError } from "@atiende/ui";
import { fetchInvoice } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo criterio que en Cfdi.tsx: espejo cosmético de RESOLVER_REVISION_ROLES
// (@atiende/domain-despachos/src/roles.ts) -- el enforcement real vive en
// revisiones.ts (assertVerticalRole), server-side.
const RESOLVER_ROLES = new Set(["admin", "contador"]);

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

export function CfdiDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const [invoice, setInvoice] = useState<InvoiceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hallazgo de auditoría severidad ALTA: el backend de revisiones
  // (GET/POST .../revisiones*, revisiones.ts) existía completo pero esta pantalla
  // solo pintaba el texto estático "Requiere revisión humana", sin cliente ni
  // botón. `GET .../revisiones` solo trae las PENDIENTES (repo.listPendingReviews,
  // sin filtro de estado) -- no hay endpoint para revisiones ya resueltas salvo por
  // id conocido, así que "no aparece en la cola" se interpreta como "ya resuelta".
  const [revision, setRevision] = useState<RevisionCfdi | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [resolviendo, setResolviendo] = useState(false);

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

  async function loadRevision() {
    if (!invoiceId) return;
    setRevisionLoading(true);
    setRevisionError(null);
    try {
      const pendientes = await fetchRevisionesPendientes(fetch, apiBaseUrl, token, propertyId);
      setRevision(pendientes.find((r) => r.invoiceId === invoiceId) ?? null);
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : "No se pudo cargar el estado de revisión.");
    } finally {
      setRevisionLoading(false);
    }
  }

  useEffect(() => {
    void loadRevision();
  }, [apiBaseUrl, token, propertyId, invoiceId]);

  async function handleResolver(decision: "aprobar" | "rechazar") {
    if (!revision) return;
    setResolviendo(true);
    setRevisionError(null);
    try {
      const notaTrim = nota.trim() || undefined;
      if (decision === "aprobar") await aprobarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      else await rechazarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      setNota("");
      await loadRevision();
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : "No se pudo resolver la revisión.");
    } finally {
      setResolviendo(false);
    }
  }

  if (!invoiceId) return <p role="alert">CFDI no especificado.</p>;
  if (loading && !invoice) return <EstadoCargando etiqueta="Cargando CFDI…" />;
  if (error) return <EstadoError mensaje={error} />;
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

      {invoice.requiereRevisionHumana && (
        <div style={{ border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ fontSize: 14, margin: 0, color: "#991b1b" }}>Revisión humana</h2>

          {revisionError && (
            <p role="alert" style={{ fontSize: 13, color: "#b91c1c", margin: 0 }}>
              {revisionError}
            </p>
          )}
          {revisionLoading && !revision && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Cargando estado de revisión…</p>}

          {!revisionLoading && !revision && !revisionError && <p style={{ fontSize: 13, color: "#166534", margin: 0 }}>Esta revisión ya fue resuelta (aprobada o rechazada).</p>}

          {revision && (
            <>
              <p style={{ fontSize: 13, color: "#374151", margin: 0 }}>{revision.motivo}</p>
              {RESOLVER_ROLES.has(role) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea
                    placeholder="Nota de la decisión (opcional)"
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                    rows={2}
                    style={{ padding: 8, borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, resize: "vertical", fontFamily: "inherit" }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => handleResolver("aprobar")}
                      disabled={resolviendo}
                      style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #166534", background: "#dcfce7", color: "#166534", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                    >
                      {resolviendo ? "…" : "Aprobar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolver("rechazar")}
                      disabled={resolviendo}
                      style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fee2e2", color: "#b91c1c", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                    >
                      {resolviendo ? "…" : "Rechazar"}
                    </button>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol no puede resolver revisiones (solo admin/contador).</p>
              )}
            </>
          )}
        </div>
      )}

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
