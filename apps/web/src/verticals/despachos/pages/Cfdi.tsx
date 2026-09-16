// Lista de CFDI emitidos/recibidos (Fase 9) — GET .../cfdi(?requiereRevisionHumana=)
// (cfdi.ts, `serializeInvoice`). La validación fiscal real (`validarCfdiDespachos`,
// que compone `validarCfdi()` de @atiende/billing con la capa de reglas fiscales
// avanzadas) ya corre en la ingesta; esta pantalla es el primer lugar donde el staff
// puede REVISAR ese resultado (válido/issues/warnings/revisión humana) sin leer la
// base de datos a mano. La ingesta en sí (POST .../cfdi) sigue siendo un flujo
// server-to-server (PAC/timbrado), fuera de alcance de esta fase — mismo criterio
// que Convocatorias.tsx/licitaciones: cerrar el gap de LECTURA real primero.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { fetchInvoices, importarCfdiXml } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const TIPO_LABELS: Record<InvoiceSummary["tipo"], string> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

// Mismo criterio que GESTIONAR_ROLES/CERRAR_ROLES en CierreMensualDetalle.tsx:
// espejo cosmético (para ocultar botones) de RESOLVER_REVISION_ROLES
// (@atiende/domain-despachos/src/roles.ts) — el enforcement real es SIEMPRE
// server-side, en revisiones.ts (assertVerticalRole).
const RESOLVER_ROLES = new Set(["admin", "contador"]);

// Espejo cosmético de INGESTA_CFDI_ROLES (@atiende/domain-despachos/src/roles.ts)
// — mismos dos roles que ya pueden `POST /cfdi`; el enforcement real vuelve a
// vivir SIEMPRE en la ruta (`assertVerticalRole`), esto solo oculta el botón.
const INGESTA_ROLES = new Set(["admin", "contador"]);

function ValidoBadge({ valido }: { valido: boolean }) {
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: valido ? "#dcfce7" : "#fee2e2", color: valido ? "#166534" : "#991b1b", fontWeight: 600 }}>
      {valido ? "Válido" : "Con hallazgos"}
    </span>
  );
}

export function CfdiPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloRevision, setSoloRevision] = useState(false);

  const [revisiones, setRevisiones] = useState<readonly RevisionCfdi[] | null>(null);
  const [revisionesLoading, setRevisionesLoading] = useState(false);
  const [revisionesError, setRevisionesError] = useState<string | null>(null);
  const [notaDrafts, setNotaDrafts] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [importando, setImportando] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const xmlInputRef = useRef<HTMLInputElement | null>(null);

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

  // Cola de revisión humana (hallazgo ALTA): independiente del filtro
  // "soloRevision" de la tabla de abajo -- GET .../revisiones siempre trae TODAS
  // las pendientes de la property, sin importar qué esté viendo el usuario en la
  // tabla de CFDI.
  async function loadRevisiones() {
    setRevisionesLoading(true);
    setRevisionesError(null);
    try {
      setRevisiones(await fetchRevisionesPendientes(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setRevisionesError(err instanceof Error ? err.message : "No se pudo cargar la cola de revisión.");
    } finally {
      setRevisionesLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, soloRevision]);

  useEffect(() => {
    void loadRevisiones();
  }, [apiBaseUrl, token, propertyId]);

  async function handleResolver(reviewId: string, decision: "aprobar" | "rechazar") {
    setResolveError(null);
    setResolvingId(reviewId);
    try {
      const nota = notaDrafts[reviewId]?.trim() || undefined;
      if (decision === "aprobar") await aprobarRevision(fetch, apiBaseUrl, token, propertyId, reviewId, nota);
      else await rechazarRevision(fetch, apiBaseUrl, token, propertyId, reviewId, nota);
      setNotaDrafts((prev) => {
        const next = { ...prev };
        delete next[reviewId];
        return next;
      });
      await Promise.all([loadRevisiones(), load()]);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "No se pudo resolver la revisión.");
    } finally {
      setResolvingId(null);
    }
  }

  // POST /despachos/:propertyId/cfdi/importar-xml (cierre de gap de auditoría:
  // hasta esta fase la ÚNICA forma de ingestar un CFDI era pegar a mano el JSON
  // de 15+ campos ya desarmado -- ver cabecera de cfdi.ts). Un CFDI real llega
  // como archivo .xml timbrado por el PAC; este botón lee el archivo local con
  // FileReader (nunca sube nada a un tercero) y manda el texto crudo tal cual.
  async function handleImportarXml(file: File) {
    setImportError(null);
    setImportOk(null);
    setImportando(true);
    try {
      const xml = await file.text();
      const invoice = await importarCfdiXml(fetch, apiBaseUrl, token, propertyId, xml);
      setImportOk(`CFDI ${invoice.folioFiscal.slice(0, 13)}… importado correctamente.`);
      await Promise.all([load(), loadRevisiones()]);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "No se pudo importar el CFDI.");
    } finally {
      setImportando(false);
      if (xmlInputRef.current) xmlInputRef.current.value = "";
    }
  }

  const invoicesById = new Map((invoices ?? []).map((inv) => [inv.id, inv] as const));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>CFDI</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Comprobantes ingestados y validados contra las reglas fiscales del SAT.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
            <input type="checkbox" checked={soloRevision} onChange={(e) => setSoloRevision(e.target.checked)} />
            Solo con revisión humana pendiente
          </label>
          {INGESTA_ROLES.has(role) && (
            <>
              <input
                ref={xmlInputRef}
                type="file"
                accept=".xml,text/xml,application/xml"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportarXml(file);
                }}
              />
              <button
                type="button"
                onClick={() => xmlInputRef.current?.click()}
                disabled={importando}
                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                {importando ? "Importando…" : "Cargar XML de CFDI"}
              </button>
            </>
          )}
        </div>
      </header>

      {importError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
          {importError}
        </p>
      )}
      {importOk && !importError && (
        <p style={{ color: "#166534", margin: 0, fontSize: 13 }}>{importOk}</p>
      )}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Cola de revisión humana</h2>
          {revisiones && <span style={{ fontSize: 12, color: "#6b7280" }}>{revisiones.length} pendiente(s)</span>}
        </div>

        {resolveError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {resolveError}
          </p>
        )}
        {revisionesError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {revisionesError}
          </p>
        )}
        {revisionesLoading && !revisiones && <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Cargando…</p>}
        {revisiones && revisiones.length === 0 && !revisionesLoading && <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>No hay CFDI pendientes de revisión humana.</p>}

        {revisiones && revisiones.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {revisiones.map((r) => {
              const inv = invoicesById.get(r.invoiceId);
              return (
                <div key={r.id} style={{ border: "1px solid #f3f4f6", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <Link to={`/despachos/${orgSlug}/cfdi/${r.invoiceId}`} style={{ fontWeight: 600, color: "#111827", textDecoration: "none", fontSize: 13 }}>
                        {inv ? (inv.emisorNombre ?? inv.rfcEmisor) : r.invoiceId}
                      </Link>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{r.motivo}</p>
                    </div>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{formatDate(r.creadoEn)}</span>
                  </div>
                  {RESOLVER_ROLES.has(role) ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        type="text"
                        placeholder="Nota (opcional)"
                        value={notaDrafts[r.id] ?? ""}
                        onChange={(e) => setNotaDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        style={{ flex: 1, minWidth: 160, padding: "6px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12 }}
                      />
                      <button
                        type="button"
                        onClick={() => handleResolver(r.id, "aprobar")}
                        disabled={resolvingId === r.id}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #166534", background: "#dcfce7", color: "#166534", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      >
                        {resolvingId === r.id ? "…" : "Aprobar"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleResolver(r.id, "rechazar")}
                        disabled={resolvingId === r.id}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fee2e2", color: "#b91c1c", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      >
                        {resolvingId === r.id ? "…" : "Rechazar"}
                      </button>
                    </div>
                  ) : (
                    <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>Tu rol no puede resolver revisiones (solo admin/contador).</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !invoices && <EstadoCargando etiqueta="Cargando CFDI…" />}

      {invoices && invoices.length === 0 && !loading && (
        <EstadoVacio mensaje={soloRevision ? "No hay CFDI pendientes de revisión humana." : "Todavía no hay ningún CFDI ingestado."} />
      )}

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
