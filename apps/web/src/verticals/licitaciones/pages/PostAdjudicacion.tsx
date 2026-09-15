// Post-adjudicación: cobranza del contrato + inconformidades (Fase 15, gap
// ALTA "Post-adjudicación completa... = 22 rutas sin UI"). Porción acotada de
// ese hallazgo: `contractBilling.ts` expone POST/GET .../contract/invoices,
// POST .../contract/invoices/:invoiceId/mark-paid y GET
// .../contract/receivables; `inconformidad.ts` expone POST/GET
// .../inconformidad y POST .../inconformidad/:id/mark-reviewed
// (INCONFORMIDAD_REVIEW_ROLES) -- ninguno tenía cliente ni página todavía.
//
// Deliberadamente FUERA de esta pieza (post-adjudicación, alcance de otro
// agente en paralelo o rondas futuras -- ver README de este vertical):
// declarar que el expediente YA se presentó ante el portal, alta del
// contrato mismo (`POST .../contract`, `contracts.ts`) y sus documentos/
// campos extraídos, la autopsia del fallo y el radar de renovaciones. Esta
// pantalla asume que el contrato YA existe (dado de alta por otra pieza) y
// muestra la explicación server-side, sin ofrecer crear el contrato, cuando
// todavía no existe.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { ContractNotFoundError, createContractInvoice, fetchContractInvoices, fetchReceivablesSummary, markContractInvoicePaid } from "../lib/contract-billing-client.ts";
import type { ContractInvoiceRecord, ReceivablesSummary } from "../lib/contract-billing-client.ts";
import { createInconformidadDraft, fetchInconformidadDrafts, markInconformidadReviewed } from "../lib/inconformidad-client.ts";
import type { InconformidadDraft } from "../lib/inconformidad-client.ts";
import { formatDate } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que `Cierre.tsx` (WRITE_ROLES de
// `@atiende/domain-licitaciones::roles.ts`) -- cosmético, oculta acciones que
// el servidor rechazaría igual (`assertVerticalRole(c, WRITE_ROLES)` en
// contractBilling.ts/inconformidad.ts); el enforcement real es siempre
// server-side.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

// INCONFORMIDAD_REVIEW_ROLES EXACTO de roles.ts (más estricto: sin "analyst"
// ni "writer" -- certificar la revisión legal de un escrito es un rol
// distinto de redactarlo o de decidir ir/no ir a una licitación).
const INCONFORMIDAD_REVIEW_ROLES = new Set(["owner", "admin", "reviewer"]);

const sectionCardStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };

const INVOICE_STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pendiente: { bg: "#fef9c3", fg: "#854d0e" },
  pagada: { bg: "#dcfce7", fg: "#166534" },
  vencida: { bg: "#fee2e2", fg: "#991b1b" },
};
const INVOICE_STATUS_LABELS: Record<string, string> = { pendiente: "Pendiente", pagada: "Pagada", vencida: "Vencida" };

function InvoiceStatusPill({ status }: { status: string }) {
  const colors = INVOICE_STATUS_COLORS[status] ?? { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>{INVOICE_STATUS_LABELS[status] ?? status}</span>;
}

const VIABILITY_COLORS: Record<string, { bg: string; fg: string }> = {
  alta: { bg: "#dcfce7", fg: "#166534" },
  media: { bg: "#fef9c3", fg: "#854d0e" },
  baja: { bg: "#fee2e2", fg: "#991b1b" },
};
const VIABILITY_LABELS: Record<string, string> = { alta: "Alta", media: "Media", baja: "Baja" };

function ViabilityPill({ viability }: { viability: string }) {
  const colors = VIABILITY_COLORS[viability] ?? { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>Viabilidad: {VIABILITY_LABELS[viability] ?? viability}</span>;
}

function DraftStatusPill({ status }: { status: string }) {
  const isRevisado = status === "revisado";
  const colors = isRevisado ? { bg: "#dcfce7", fg: "#166534" } : { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>{isRevisado ? "Revisado" : "Borrador"}</span>;
}

/** Convierte un textarea de líneas libres en un arreglo de cadenas no vacías -- mismo criterio que el resto del panel (una idea por línea, sin JSON a mano). */
function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function PostAdjudicacionPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();

  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [loadingTender, setLoadingTender] = useState(false);
  const [tenderError, setTenderError] = useState<string | null>(null);

  const canWrite = WRITE_ROLES.has(role);
  const canReviewInconformidad = INCONFORMIDAD_REVIEW_ROLES.has(role);

  // ---- Facturación / cobranza del contrato ----
  const [invoices, setInvoices] = useState<readonly ContractInvoiceRecord[] | null>(null);
  const [receivables, setReceivables] = useState<ReceivablesSummary | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [contractMissing, setContractMissing] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  const [conceptoText, setConceptoText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [invoiceVerifiedOnText, setInvoiceVerifiedOnText] = useState(() => new Date().toISOString().slice(0, 10));
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [createInvoiceError, setCreateInvoiceError] = useState<string | null>(null);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  // ---- Inconformidades ----
  const [drafts, setDrafts] = useState<readonly InconformidadDraft[] | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);

  const [hechosText, setHechosText] = useState("");
  const [agraviosText, setAgraviosText] = useState("");
  const [pruebasText, setPruebasText] = useState("");
  const [falloNotifiedOnText, setFalloNotifiedOnText] = useState("");
  const [bajoTratados, setBajoTratados] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [generateDraftError, setGenerateDraftError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function loadTender(id: string) {
    setLoadingTender(true);
    setTenderError(null);
    try {
      setTender(await fetchTender(fetch, apiBaseUrl, token, propertyId, id));
    } catch (err) {
      setTenderError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoadingTender(false);
    }
  }

  async function loadBilling(id: string) {
    setBillingLoading(true);
    setBillingError(null);
    setContractMissing(false);
    try {
      const [invoicesData, receivablesData] = await Promise.all([
        fetchContractInvoices(fetch, apiBaseUrl, token, propertyId, id),
        fetchReceivablesSummary(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setInvoices(invoicesData);
      setReceivables(receivablesData);
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        setContractMissing(true);
        setInvoices(null);
        setReceivables(null);
      } else {
        setBillingError(err instanceof Error ? err.message : "No se pudo cargar la facturación del contrato.");
      }
    } finally {
      setBillingLoading(false);
    }
  }

  async function loadDrafts(id: string) {
    setDraftsLoading(true);
    setDraftsError(null);
    try {
      setDrafts(await fetchInconformidadDrafts(fetch, apiBaseUrl, token, propertyId, id));
    } catch (err) {
      setDraftsError(err instanceof Error ? err.message : "No se pudieron cargar los borradores de inconformidad.");
    } finally {
      setDraftsLoading(false);
    }
  }

  useEffect(() => {
    if (!tenderId) return;
    void loadTender(tenderId);
    void loadBilling(tenderId);
    void loadDrafts(tenderId);
    // eslint: mismo criterio que el resto del panel (sin eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function handleCreateInvoice(event: FormEvent) {
    event.preventDefault();
    if (!tenderId) return;
    setCreateInvoiceError(null);

    const concepto = conceptoText.trim();
    if (concepto.length === 0) {
      setCreateInvoiceError("El concepto es obligatorio.");
      return;
    }
    const amount = amountText.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      setCreateInvoiceError('El monto debe ser una cantidad válida, p. ej. "12345.67" (sin negativos aquí -- una factura no es un monto negativo).');
      return;
    }
    if (invoiceVerifiedOnText.trim().length === 0) {
      setCreateInvoiceError("Declara la fecha en que se verificó la factura.");
      return;
    }

    setCreatingInvoice(true);
    try {
      await createContractInvoice(fetch, apiBaseUrl, token, propertyId, tenderId, { concepto, amount, invoiceVerifiedOn: invoiceVerifiedOnText.trim() });
      setConceptoText("");
      setAmountText("");
      await loadBilling(tenderId);
    } catch (err) {
      setCreateInvoiceError(err instanceof Error ? err.message : "No se pudo registrar la factura.");
    } finally {
      setCreatingInvoice(false);
    }
  }

  async function handleMarkPaid(invoiceId: string) {
    if (!tenderId) return;
    setMarkPaidError(null);
    setMarkingPaidId(invoiceId);
    try {
      await markContractInvoicePaid(fetch, apiBaseUrl, token, propertyId, tenderId, invoiceId);
      await loadBilling(tenderId);
    } catch (err) {
      setMarkPaidError(err instanceof Error ? err.message : "No se pudo marcar la factura como pagada.");
    } finally {
      setMarkingPaidId(null);
    }
  }

  async function handleGenerateDraft(event: FormEvent) {
    event.preventDefault();
    if (!tenderId) return;
    setGenerateDraftError(null);

    const hechos = linesToList(hechosText);
    if (hechos.length === 0) {
      setGenerateDraftError("Declara al menos un hecho (uno por línea).");
      return;
    }
    const agravios = linesToList(agraviosText);
    if (agravios.length === 0) {
      setGenerateDraftError("Declara al menos un agravio (uno por línea).");
      return;
    }
    const pruebas = linesToList(pruebasText);
    if (falloNotifiedOnText.trim().length === 0) {
      setGenerateDraftError("Declara la fecha en que se notificó el fallo.");
      return;
    }

    setGeneratingDraft(true);
    try {
      const draft = await createInconformidadDraft(fetch, apiBaseUrl, token, propertyId, tenderId, {
        hechos,
        agravios,
        pruebas,
        falloNotifiedOn: falloNotifiedOnText.trim(),
        bajoTratados,
      });
      setDrafts((prev) => [draft, ...(prev ?? [])]);
      setHechosText("");
      setAgraviosText("");
      setPruebasText("");
    } catch (err) {
      setGenerateDraftError(err instanceof Error ? err.message : "No se pudo generar el borrador de inconformidad.");
    } finally {
      setGeneratingDraft(false);
    }
  }

  async function handleMarkReviewed(draftId: string) {
    if (!tenderId) return;
    setReviewError(null);
    setReviewingId(draftId);
    try {
      const updated = await markInconformidadReviewed(fetch, apiBaseUrl, token, propertyId, tenderId, draftId);
      setDrafts((prev) => (prev ?? []).map((d) => (d.id === draftId ? updated : d)));
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "No se pudo marcar el borrador como revisado.");
    } finally {
      setReviewingId(null);
    }
  }

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loadingTender && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (tenderError) return <p role="alert" style={{ color: "#b91c1c" }}>{tenderError}</p>;
  if (!tender) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title}
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Post-adjudicación: cobranza e inconformidades</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Seguimiento de pagos contra el contrato ya adjudicado y redacción de borradores de inconformidad contra el fallo. La presentación de escritos ante cualquier autoridad, y el alta del contrato mismo, no viven en esta pantalla.
        </p>
      </div>

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Facturación y cuentas por cobrar del contrato</h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            El vencimiento de cada factura (17 días hábiles desde su verificación, Art. 73 LAASSP) SIEMPRE lo calcula el servidor -- nunca se declara aquí. Una factura pasa a "vencida" en cuanto se cumple el plazo sin registrar el pago.
          </p>
        </div>

        {billingLoading && invoices === null && !contractMissing && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Cargando…</p>}

        {contractMissing && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 10 }}>
            Esta convocatoria todavía no tiene un contrato registrado -- la cobranza requiere un contrato existente. El alta del contrato es una pantalla aparte (fuera de esta pieza).
          </p>
        )}

        {billingError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {billingError}
          </p>
        )}

        {receivables && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Pendiente por cobrar</p>
              <p style={{ fontSize: 16, margin: "4px 0 0", fontWeight: 600 }}>${receivables.totalPending}</p>
              <p style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 0" }}>{receivables.countPending} factura(s)</p>
            </div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Vencido</p>
              <p style={{ fontSize: 16, margin: "4px 0 0", fontWeight: 600, color: receivables.countOverdue > 0 ? "#991b1b" : undefined }}>${receivables.totalOverdue}</p>
              <p style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 0" }}>{receivables.countOverdue} factura(s)</p>
            </div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Al corte de</p>
              <p style={{ fontSize: 16, margin: "4px 0 0", fontWeight: 600 }}>{formatDate(`${receivables.asOfDate}T00:00:00Z`)}</p>
            </div>
          </div>
        )}

        {invoices && invoices.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {invoices.map((inv) => (
              <div key={inv.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, borderBottom: "1px solid #f3f4f6", paddingBottom: 8, fontSize: 13 }}>
                <div style={{ flex: "1 1 220px" }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>
                    {inv.concepto} · ${inv.amount}
                  </p>
                  <p style={{ margin: "2px 0 0", color: "#6b7280", fontSize: 12 }}>
                    Verificada {formatDate(`${inv.invoiceVerifiedOn}T00:00:00Z`)} · vence {formatDate(`${inv.dueDate}T00:00:00Z`)}
                    {inv.paidAt ? ` · pagada ${formatDate(inv.paidAt)}` : ""}
                  </p>
                </div>
                <InvoiceStatusPill status={inv.status} />
                {inv.status !== "pagada" && canWrite && (
                  <button
                    type="button"
                    onClick={() => void handleMarkPaid(inv.id)}
                    disabled={markingPaidId === inv.id}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                  >
                    {markingPaidId === inv.id ? "Marcando…" : "Marcar pagada"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {invoices && invoices.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no hay facturas registradas contra este contrato.</p>}

        {markPaidError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {markPaidError}
          </p>
        )}

        {canWrite && !contractMissing && (
          <form onSubmit={(e) => void handleCreateInvoice(e)} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "2 1 220px" }}>
              Concepto
              <input value={conceptoText} onChange={(e) => setConceptoText(e.target.value)} placeholder="Primera exhibición" style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 140px" }}>
              Monto
              <input value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="12345.67" style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 160px" }}>
              Fecha de verificación
              <input type="date" value={invoiceVerifiedOnText} onChange={(e) => setInvoiceVerifiedOnText(e.target.value)} style={inputStyle} />
            </label>
            <button
              type="submit"
              disabled={creatingInvoice}
              style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {creatingInvoice ? "Registrando…" : "Registrar factura"}
            </button>
            {createInvoiceError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 12, flexBasis: "100%" }}>
                {createInvoiceError}
              </p>
            )}
          </form>
        )}
        {!canWrite && !contractMissing && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede registrar ni marcar facturas -- solo lectura.</p>}
      </section>

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Inconformidades contra el fallo</h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            {`Genera un BORRADOR estructurado (hechos/agravios/pruebas/fundamentos legales/plazo) -- esto NUNCA se presenta ante ninguna autoridad desde aquí, NO es asesoría legal, y siempre requiere revisión de abogado antes de usarse.`}
          </p>
        </div>

        {draftsLoading && drafts === null && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Cargando…</p>}
        {draftsError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {draftsError}
          </p>
        )}

        {drafts && drafts.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {drafts.map((d) => (
              <div key={d.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                    Versión {d.version} · límite {formatDate(`${d.plazo.fechaLimite}T00:00:00Z`)} ({d.plazo.diasHabiles} días hábiles)
                  </p>
                  <div style={{ display: "flex", gap: 6 }}>
                    <ViabilityPill viability={d.viability} />
                    <DraftStatusPill status={d.status} />
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>{d.viabilityRecommendation}</p>
                <p style={{ margin: 0, fontSize: 11, color: "#991b1b", fontStyle: "italic" }}>{d.disclaimer}</p>
                <details>
                  <summary style={{ fontSize: 12, color: "#111827", cursor: "pointer" }}>Ver hechos, agravios y fundamentos ({d.fundamentos.length})</summary>
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                    <div>
                      <p style={{ margin: "0 0 2px", fontWeight: 600 }}>Hechos</p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {d.hechos.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p style={{ margin: "0 0 2px", fontWeight: 600 }}>Agravios</p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {d.agravios.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                    {d.pruebas.length > 0 && (
                      <div>
                        <p style={{ margin: "0 0 2px", fontWeight: 600 }}>Pruebas</p>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {d.pruebas.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div>
                      <p style={{ margin: "0 0 2px", fontWeight: 600 }}>Fundamentos legales</p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {d.fundamentos.map((f, i) => (
                          <li key={i}>
                            {f.ley} {f.articulo}: {f.texto}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </details>
                {d.status === "borrador" && canReviewInconformidad && (
                  <button
                    type="button"
                    onClick={() => void handleMarkReviewed(d.id)}
                    disabled={reviewingId === d.id}
                    style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 6, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                  >
                    {reviewingId === d.id ? "Marcando…" : "Marcar como revisado por abogado"}
                  </button>
                )}
                {d.status === "revisado" && (
                  <p style={{ margin: 0, fontSize: 11, color: "#166534" }}>
                    Revisado {d.reviewedAt ? formatDate(d.reviewedAt) : ""}.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {drafts && drafts.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no se ha generado ningún borrador de inconformidad para esta convocatoria.</p>}

        {reviewError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {reviewError}
          </p>
        )}
        {!canReviewInconformidad && drafts && drafts.some((d) => d.status === "borrador") && (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede marcar un borrador como revisado -- solo owner/admin/reviewer.</p>
        )}

        {canWrite ? (
          <form onSubmit={(e) => void handleGenerateDraft(e)} style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "#374151" }}>Generar un nuevo borrador (cada envío crea una versión nueva, nunca edita una existente)</p>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              Hechos (uno por línea)
              <textarea value={hechosText} onChange={(e) => setHechosText(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              Agravios (uno por línea)
              <textarea value={agraviosText} onChange={(e) => setAgraviosText(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              Pruebas (uno por línea, opcional -- sin pruebas la viabilidad se clasifica como "baja")
              <textarea value={pruebasText} onChange={(e) => setPruebasText(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 180px" }}>
                Fecha de notificación del fallo
                <input type="date" value={falloNotifiedOnText} onChange={(e) => setFalloNotifiedOnText(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={bajoTratados} onChange={(e) => setBajoTratados(e.target.checked)} />
                Licitación pública internacional bajo cobertura de tratados (10 días hábiles en vez de 6)
              </label>
            </div>
            {generateDraftError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 12 }}>
                {generateDraftError}
              </p>
            )}
            <button
              type="submit"
              disabled={generatingDraft}
              style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {generatingDraft ? "Generando…" : "Generar borrador"}
            </button>
          </form>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede generar borradores de inconformidad -- solo lectura.</p>
        )}
      </section>
    </div>
  );
}
