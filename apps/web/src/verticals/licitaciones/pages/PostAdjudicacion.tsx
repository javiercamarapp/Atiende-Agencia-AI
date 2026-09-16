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
//
// Fase "sistema de diseño real" (contenido) — los dos bloques pasan a `Tabs`
// (cobranza / inconformidades) sobre `Card`, el resumen de cuentas por cobrar a
// `StatCard`, los pills de estatus/viabilidad a `Badge`, y todos los inputs y
// botones a `Input`/`Label`/`Button` de @atiende/ui. Cero cambios de lógica.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarDays, CircleDollarSign, Clock } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  StatCard,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
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

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Mismo ámbar de antes, sin hex sueltos: `outline` + tokens de Tailwind. */
const AMBAR = "border-amber-500/60 text-amber-600 dark:text-amber-400";

/** `<textarea>` sigue siendo nativo (el sistema no exporta un primitivo
 * propio): solo se restila con los tokens reales. */
const CAMPO_NATIVO =
  "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const INVOICE_STATUS_BADGE: Record<string, { variant: BadgeVariant; className?: string }> = {
  pendiente: { variant: "outline", className: AMBAR },
  pagada: { variant: "default" },
  vencida: { variant: "destructive" },
};
const INVOICE_STATUS_LABELS: Record<string, string> = { pendiente: "Pendiente", pagada: "Pagada", vencida: "Vencida" };

function InvoiceStatusPill({ status }: { status: string }) {
  const cfg = INVOICE_STATUS_BADGE[status] ?? { variant: "secondary" as const };
  return (
    <Badge variant={cfg.variant} className={cfg.className ? `${cfg.className} whitespace-nowrap` : "whitespace-nowrap"}>
      {INVOICE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const VIABILITY_BADGE: Record<string, { variant: BadgeVariant; className?: string }> = {
  alta: { variant: "default" },
  media: { variant: "outline", className: AMBAR },
  baja: { variant: "destructive" },
};
const VIABILITY_LABELS: Record<string, string> = { alta: "Alta", media: "Media", baja: "Baja" };

function ViabilityPill({ viability }: { viability: string }) {
  const cfg = VIABILITY_BADGE[viability] ?? { variant: "secondary" as const };
  return (
    <Badge variant={cfg.variant} className={cfg.className ? `${cfg.className} whitespace-nowrap` : "whitespace-nowrap"}>
      Viabilidad: {VIABILITY_LABELS[viability] ?? viability}
    </Badge>
  );
}

function DraftStatusPill({ status }: { status: string }) {
  const isRevisado = status === "revisado";
  return (
    <Badge variant={isRevisado ? "default" : "secondary"} className="whitespace-nowrap">
      {isRevisado ? "Revisado" : "Borrador"}
    </Badge>
  );
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

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loadingTender && !tender) return <EstadoCargando etiqueta="Cargando convocatoria…" />;
  if (tenderError) return <EstadoError mensaje={tenderError} onReintentar={() => void loadTender(tenderId)} />;
  if (!tender) return null;

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Post-adjudicación: cobranza e inconformidades</h1>
        <p className="text-[13px] text-muted-foreground">
          Seguimiento de pagos contra el contrato ya adjudicado y redacción de borradores de inconformidad contra el fallo. La presentación de escritos ante cualquier autoridad, y el alta del contrato mismo, no viven en esta pantalla.
        </p>
      </div>

      <Tabs defaultValue="cobranza" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="cobranza">Cobranza</TabsTrigger>
          <TabsTrigger value="inconformidades">Inconformidades</TabsTrigger>
        </TabsList>

        <TabsContent value="cobranza">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Facturación y cuentas por cobrar del contrato</CardTitle>
              <CardDescription>
                El vencimiento de cada factura (17 días hábiles desde su verificación, Art. 73 LAASSP) SIEMPRE lo calcula el servidor -- nunca se declara aquí. Una factura pasa a "vencida" en cuanto se cumple el plazo sin registrar el pago.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {billingLoading && invoices === null && !contractMissing && <EstadoCargando lineas={2} etiqueta="Cargando facturación…" />}

              {contractMissing && (
                <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[13px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  Esta convocatoria todavía no tiene un contrato registrado -- la cobranza requiere un contrato existente. El alta del contrato es una pantalla aparte (fuera de esta pieza).
                </p>
              )}

              {billingError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {billingError}
                </p>
              )}

              {receivables && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatCard icon={CircleDollarSign} label="Pendiente por cobrar" value={`$${receivables.totalPending}`} nota={`${receivables.countPending} factura(s)`} />
                  <StatCard icon={Clock} label="Vencido" value={`$${receivables.totalOverdue}`} nota={`${receivables.countOverdue} factura(s)`} />
                  <StatCard icon={CalendarDays} label="Al corte de" value={formatDate(`${receivables.asOfDate}T00:00:00Z`)} />
                </div>
              )}

              {invoices && invoices.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {invoices.map((inv) => (
                    <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 text-[13px]">
                      <div className="flex-[1_1_220px]">
                        <p className="font-semibold text-foreground">
                          {inv.concepto} · ${inv.amount}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Verificada {formatDate(`${inv.invoiceVerifiedOn}T00:00:00Z`)} · vence {formatDate(`${inv.dueDate}T00:00:00Z`)}
                          {inv.paidAt ? ` · pagada ${formatDate(inv.paidAt)}` : ""}
                        </p>
                      </div>
                      <InvoiceStatusPill status={inv.status} />
                      {inv.status !== "pagada" && canWrite && (
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleMarkPaid(inv.id)} disabled={markingPaidId === inv.id}>
                          {markingPaidId === inv.id ? "Marcando…" : "Marcar pagada"}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {invoices && invoices.length === 0 && <EstadoVacio mensaje="Todavía no hay facturas registradas contra este contrato." />}

              {markPaidError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {markPaidError}
                </p>
              )}

              {canWrite && !contractMissing && (
                <form onSubmit={(e) => void handleCreateInvoice(e)} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                  <div className="flex flex-[2_1_220px] flex-col gap-1.5">
                    <Label htmlFor="factura-concepto">Concepto</Label>
                    <Input id="factura-concepto" value={conceptoText} onChange={(e) => setConceptoText(e.target.value)} placeholder="Primera exhibición" />
                  </div>
                  <div className="flex flex-[1_1_140px] flex-col gap-1.5">
                    <Label htmlFor="factura-monto">Monto</Label>
                    <Input id="factura-monto" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="12345.67" />
                  </div>
                  <div className="flex flex-[1_1_160px] flex-col gap-1.5">
                    <Label htmlFor="factura-verificacion">Fecha de verificación</Label>
                    <Input id="factura-verificacion" type="date" value={invoiceVerifiedOnText} onChange={(e) => setInvoiceVerifiedOnText(e.target.value)} />
                  </div>
                  <Button type="submit" size="sm" disabled={creatingInvoice}>
                    {creatingInvoice ? "Registrando…" : "Registrar factura"}
                  </Button>
                  {createInvoiceError && (
                    <p role="alert" className="basis-full text-xs text-destructive">
                      {createInvoiceError}
                    </p>
                  )}
                </form>
              )}
              {!canWrite && !contractMissing && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede registrar ni marcar facturas -- solo lectura.</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inconformidades">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Inconformidades contra el fallo</CardTitle>
              <CardDescription>
                {`Genera un BORRADOR estructurado (hechos/agravios/pruebas/fundamentos legales/plazo) -- esto NUNCA se presenta ante ninguna autoridad desde aquí, NO es asesoría legal, y siempre requiere revisión de abogado antes de usarse.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {draftsLoading && drafts === null && <EstadoCargando lineas={2} etiqueta="Cargando borradores…" />}
              {draftsError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {draftsError}
                </p>
              )}

              {drafts && drafts.length > 0 && (
                <div className="flex flex-col gap-3">
                  {drafts.map((d) => (
                    <div key={d.id} className="flex flex-col gap-2 rounded-xl border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[13px] font-semibold text-foreground">
                          Versión {d.version} · límite {formatDate(`${d.plazo.fechaLimite}T00:00:00Z`)} ({d.plazo.diasHabiles} días hábiles)
                        </p>
                        <div className="flex gap-1.5">
                          <ViabilityPill viability={d.viability} />
                          <DraftStatusPill status={d.status} />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{d.viabilityRecommendation}</p>
                      <p className="text-[11px] italic text-destructive">{d.disclaimer}</p>
                      <details>
                        <summary className="cursor-pointer text-xs text-foreground">Ver hechos, agravios y fundamentos ({d.fundamentos.length})</summary>
                        <div className="mt-2 flex flex-col gap-2 text-xs">
                          <div>
                            <p className="mb-0.5 font-semibold text-foreground">Hechos</p>
                            <ul className="list-disc pl-5 text-muted-foreground">
                              {d.hechos.map((h, i) => (
                                <li key={i}>{h}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <p className="mb-0.5 font-semibold text-foreground">Agravios</p>
                            <ul className="list-disc pl-5 text-muted-foreground">
                              {d.agravios.map((a, i) => (
                                <li key={i}>{a}</li>
                              ))}
                            </ul>
                          </div>
                          {d.pruebas.length > 0 && (
                            <div>
                              <p className="mb-0.5 font-semibold text-foreground">Pruebas</p>
                              <ul className="list-disc pl-5 text-muted-foreground">
                                {d.pruebas.map((p, i) => (
                                  <li key={i}>{p}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div>
                            <p className="mb-0.5 font-semibold text-foreground">Fundamentos legales</p>
                            <ul className="list-disc pl-5 text-muted-foreground">
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
                        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void handleMarkReviewed(d.id)} disabled={reviewingId === d.id}>
                          {reviewingId === d.id ? "Marcando…" : "Marcar como revisado por abogado"}
                        </Button>
                      )}
                      {d.status === "revisado" && (
                        <p className="text-[11px] font-medium text-green-600 dark:text-green-500">Revisado {d.reviewedAt ? formatDate(d.reviewedAt) : ""}.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {drafts && drafts.length === 0 && <EstadoVacio mensaje="Todavía no se ha generado ningún borrador de inconformidad para esta convocatoria." />}

              {reviewError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {reviewError}
                </p>
              )}
              {!canReviewInconformidad && drafts && drafts.some((d) => d.status === "borrador") && (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede marcar un borrador como revisado -- solo owner/admin/reviewer.</p>
              )}

              {canWrite ? (
                <form onSubmit={(e) => void handleGenerateDraft(e)} className="flex flex-col gap-2.5 border-t border-border pt-3">
                  <p className="text-xs font-semibold text-foreground">Generar un nuevo borrador (cada envío crea una versión nueva, nunca edita una existente)</p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="inc-hechos">Hechos (uno por línea)</Label>
                    <textarea id="inc-hechos" value={hechosText} onChange={(e) => setHechosText(e.target.value)} rows={3} className={CAMPO_NATIVO} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="inc-agravios">Agravios (uno por línea)</Label>
                    <textarea id="inc-agravios" value={agraviosText} onChange={(e) => setAgraviosText(e.target.value)} rows={3} className={CAMPO_NATIVO} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="inc-pruebas">Pruebas (uno por línea, opcional -- sin pruebas la viabilidad se clasifica como "baja")</Label>
                    <textarea id="inc-pruebas" value={pruebasText} onChange={(e) => setPruebasText(e.target.value)} rows={2} className={CAMPO_NATIVO} />
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-[1_1_180px] flex-col gap-1.5">
                      <Label htmlFor="inc-fallo">Fecha de notificación del fallo</Label>
                      <Input id="inc-fallo" type="date" value={falloNotifiedOnText} onChange={(e) => setFalloNotifiedOnText(e.target.value)} />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input type="checkbox" checked={bajoTratados} onChange={(e) => setBajoTratados(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                      Licitación pública internacional bajo cobertura de tratados (10 días hábiles en vez de 6)
                    </label>
                  </div>
                  {generateDraftError && (
                    <p role="alert" className="text-xs text-destructive">
                      {generateDraftError}
                    </p>
                  )}
                  <Button type="submit" size="sm" className="self-start" disabled={generatingDraft}>
                    {generatingDraft ? "Generando…" : "Generar borrador"}
                  </Button>
                </form>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede generar borradores de inconformidad -- solo lectura.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
