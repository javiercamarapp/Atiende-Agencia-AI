// Lista de CFDI emitidos/recibidos (Fase 9) — GET .../cfdi(?requiereRevisionHumana=)
// (cfdi.ts, `serializeInvoice`). La validación fiscal real (`validarCfdiDespachos`,
// que compone `validarCfdi()` de @atiende/billing con la capa de reglas fiscales
// avanzadas) ya corre en la ingesta; esta pantalla es el primer lugar donde el staff
// puede REVISAR ese resultado (válido/issues/warnings/revisión humana) sin leer la
// base de datos a mano. La ingesta en sí (POST .../cfdi) sigue siendo un flujo
// server-to-server (PAC/timbrado), fuera de alcance de esta fase — mismo criterio
// que Convocatorias.tsx/licitaciones: cerrar el gap de LECTURA real primero.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchInvoices } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const TIPO_LABELS: Record<InvoiceSummary["tipo"], string> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

function ValidoBadge({ valido }: { valido: boolean }) {
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: valido ? "#dcfce7" : "#fee2e2", color: valido ? "#166534" : "#991b1b", fontWeight: 600 }}>
      {valido ? "Válido" : "Con hallazgos"}
    </span>
  );
}

export function CfdiPage({ apiBaseUrl, token, propertyId, orgSlug }: DespachosShellContext) {
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloRevision, setSoloRevision] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInvoices(await fetchInvoices(fetch, apiBaseUrl, token, propertyId, soloRevision ? { requiereRevisionHumana: true } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los CFDI.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, soloRevision]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>CFDI</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Comprobantes ingestados y validados contra las reglas fiscales del SAT.</p>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
          <input type="checkbox" checked={soloRevision} onChange={(e) => setSoloRevision(e.target.checked)} />
          Solo con revisión humana pendiente
        </label>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {loading && !invoices && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {invoices && invoices.length === 0 && !loading && <p style={{ color: "#6b7280" }}>{soloRevision ? "No hay CFDI pendientes de revisión humana." : "Todavía no hay ningún CFDI ingestado."}</p>}

      {invoices && invoices.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Folio fiscal</th>
                <th style={{ padding: "6px 8px" }}>Tipo</th>
                <th style={{ padding: "6px 8px" }}>Emisor</th>
                <th style={{ padding: "6px 8px" }}>Total</th>
                <th style={{ padding: "6px 8px" }}>Estatus</th>
                <th style={{ padding: "6px 8px" }}>Revisión</th>
                <th style={{ padding: "6px 8px" }}>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px" }}>
                    <Link to={`/despachos/${orgSlug}/cfdi/${inv.id}`} style={{ color: "#111827", fontWeight: 600, textDecoration: "none", fontFamily: "monospace", fontSize: 12 }}>
                      {inv.folioFiscal.slice(0, 13)}…
                    </Link>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{inv.rfcReceptor}</div>
                  </td>
                  <td style={{ padding: "8px", color: "#374151" }}>{TIPO_LABELS[inv.tipo] ?? inv.tipo}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{inv.emisorNombre ?? inv.rfcEmisor}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatMoney(inv.total)}</td>
                  <td style={{ padding: "8px" }}>
                    <ValidoBadge valido={inv.valido} />
                  </td>
                  <td style={{ padding: "8px", color: inv.requiereRevisionHumana ? "#b91c1c" : "#9ca3af" }}>{inv.requiereRevisionHumana ? "Pendiente" : "—"}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatDate(inv.creadoEn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
