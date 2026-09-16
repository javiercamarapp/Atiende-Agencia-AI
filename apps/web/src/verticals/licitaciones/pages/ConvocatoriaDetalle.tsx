// Ficha de una convocatoria (Fase 7) — trae junto lo que hoy solo existía disperso
// en 3 endpoints sin ninguna pantalla real: el `TenderRecord` (tenders.ts), el
// detalle de matching/elegibilidad con el desglose por criterio (matching.ts) y el
// historial COMPLETO de decisiones go/no-go + el formulario para tomar una nueva
// (goNoGo.ts, Fase 3 §7) -- más un resumen de solo lectura del checklist de
// integridad (checklist.ts, L1 · Flujo 1). El checklist NUNCA se ejecuta desde
// aquí (ver checklist-client.ts::fetchChecklist, solo GET): `POST
// .../checklist/run` exige metadatos reales de archivos/firmas/anexos que se
// capturan en `pages/Cierre.tsx` (Fase 14, enlazada abajo) -- esta ficha solo
// muestra el último resultado ya corrido, sin duplicar ese formulario aquí.
//
// Fase "sistema de diseño real" (contenido) — las cuatro secciones apiladas
// (matching / go-no-go / resolución / checklist) pasan a `Tabs` reales, los
// KPIs del encabezado a `StatCard`, los pills de resultado/decisión a `Badge`,
// y todos los botones/inputs a `Button`/`Input`/`Label` de @atiende/ui. Mismo
// estado, mismos fetch, mismas ramas condicionales (los triggers de matching y
// checklist solo aparecen cuando el dato existe, igual que las `<section>` que
// reemplazan).
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, CircleDollarSign, FileCheck2, Flag } from "lucide-react";
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
  Label,
  StatCard,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchMatchingDetail } from "../lib/matching-client.ts";
import type { MatchResult } from "../lib/matching-client.ts";
import { createGoNoGoDecision, fetchGoNoGoDecisions } from "../lib/go-no-go-client.ts";
import type { GoNoGoDecision, GoNoGoDecisionValue } from "../lib/go-no-go-client.ts";
import { fetchChecklist } from "../lib/checklist-client.ts";
import type { ChecklistSummary } from "../lib/checklist-client.ts";
import { fetchTenderResolutions, resolveTender } from "../lib/resolution-client.ts";
import type { TenderResolutionRecord, TenderResolutionValue } from "../lib/resolution-client.ts";
import { formatComplianceResult, formatDate, formatDeadline, formatEligibility, formatMoney, formatTenderStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const GO_NO_GO_ROLES = new Set(["owner", "admin", "analyst", "reviewer"]);
// Marcar ganada/perdida es una decisión comercial/legal -- DECISION_ROLES
// exacto (sin "reviewer"), mismo criterio que el servidor (resolution.ts).
const RESOLUTION_ROLES = new Set(["owner", "admin", "analyst"]);
// Espejo local de `TENDER_RESOLVABLE_FROM_STATUSES` (tender-resolution.ts) --
// solo cosmético (oculta el formulario cuando el servidor lo rechazaría
// igual con 409); la validación real vive SIEMPRE en el servidor.
const RESOLVABLE_FROM_STATUSES = new Set(["go", "in_progress", "submitted"]);

/** Mismo semáforo verde/ámbar/rojo de antes, ahora sobre variantes de `Badge`
 * (el ámbar no tiene variante propia en el sistema: se resuelve con `outline`
 * + tokens, nunca con un hex suelto). */
const RESULT_BADGE: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  verde: { variant: "default" },
  ambar: { variant: "outline", className: "border-amber-500/60 text-amber-600 dark:text-amber-400" },
  rojo: { variant: "destructive" },
};

function ResultDot({ result }: { result: string }) {
  const cfg = RESULT_BADGE[result] ?? { variant: "secondary" as const };
  return (
    <Badge variant={cfg.variant} className={cfg.className}>
      {formatComplianceResult(result)}
    </Badge>
  );
}

const ENLACE_SECUNDARIO = "inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-foreground no-underline hover:underline";

export function ConvocatoriaDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [decisions, setDecisions] = useState<readonly GoNoGoDecision[]>([]);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(null);
  const [resolutions, setResolutions] = useState<readonly TenderResolutionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reasonsText, setReasonsText] = useState("");
  const [submitting, setSubmitting] = useState<GoNoGoDecisionValue | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [resolutionReasonText, setResolutionReasonText] = useState("");
  const [resolvingAs, setResolvingAs] = useState<TenderResolutionValue | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  async function load(id: string) {
    setLoading(true);
    setError(null);
    try {
      const [tenderData, matchData, decisionsData, checklistData, resolutionsData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchMatchingDetail(fetch, apiBaseUrl, token, propertyId, id),
        fetchGoNoGoDecisions(fetch, apiBaseUrl, token, propertyId, id),
        fetchChecklist(fetch, apiBaseUrl, token, propertyId, id),
        fetchTenderResolutions(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setTender(tenderData);
      setMatch(matchData);
      setDecisions(decisionsData);
      setChecklist(checklistData);
      setResolutions(resolutionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function handleDecision(decision: GoNoGoDecisionValue) {
    if (!tenderId) return;
    setDecisionError(null);
    const reasons = reasonsText
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    if (reasons.length === 0) {
      setDecisionError("Escribe al menos un motivo (uno por línea).");
      return;
    }
    setSubmitting(decision);
    try {
      await createGoNoGoDecision(fetch, apiBaseUrl, token, propertyId, tenderId, { decision, reasons });
      setReasonsText("");
      await load(tenderId);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "No se pudo registrar la decisión.");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleResolve(resolution: TenderResolutionValue) {
    if (!tenderId) return;
    setResolutionError(null);
    const reason = resolutionReasonText.trim();
    if (reason.length === 0) {
      setResolutionError("Escribe un motivo.");
      return;
    }
    setResolvingAs(resolution);
    try {
      // El servidor SIEMPRE revalida la transición en vivo (`checkTenderResolution`,
      // tender-resolution.ts) -- un 409 aquí significa que el estado actual de
      // la convocatoria ya no admite esta resolución (p. ej. cambió mientras
      // esta pantalla estaba abierta), nunca se aplica a medias.
      await resolveTender(fetch, apiBaseUrl, token, propertyId, tenderId, { resolution, reason });
      setResolutionReasonText("");
      await load(tenderId);
    } catch (err) {
      setResolutionError(err instanceof Error ? err.message : "No se pudo registrar la resolución.");
    } finally {
      setResolvingAs(null);
    }
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando convocatoria…" />;
  if (error) return <EstadoError mensaje={error} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Convocatorias
        </Link>
        <h1 className="text-xl font-semibold text-foreground">{tender.title}</h1>
        <p className="text-[13px] text-muted-foreground">
          {tender.contractingBody ?? "Entidad no declarada"} {tender.externalId ? `· ${tender.externalId}` : ""}
        </p>
        <div className="mt-2 flex flex-col gap-1">
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} className={ENLACE_SECUNDARIO}>
            Subir bases y ver requisitos extraídos →
          </Link>
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} className={ENLACE_SECUNDARIO}>
            Correr checklist, aprobar y ensamblar el paquete de cierre →
          </Link>
          {tender.status === "won" && (
            <>
              <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/contrato`} className={ENLACE_SECUNDARIO}>
                Ver/registrar el contrato post-adjudicación →
              </Link>
              <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/post-adjudicacion`} className={ENLACE_SECUNDARIO}>
                Cobranza del contrato e inconformidades (post-adjudicación) →
              </Link>
            </>
          )}
          {tender.status === "lost" && (
            <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/autopsia`} className={ENLACE_SECUNDARIO}>
              Autopsia del fallo y lecciones aprendidas →
            </Link>
          )}
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard icon={CalendarClock} label="Fecha límite" value={formatDeadline(tender.submissionDeadline)} />
        <StatCard icon={CircleDollarSign} label="Presupuesto" value={formatMoney(tender.budgetAmount, tender.currency)} />
        <StatCard icon={Flag} label="Estatus" value={formatTenderStatus(tender.status)} />
      </section>

      <Tabs defaultValue={match ? "matching" : "go-no-go"} className="w-full">
        <TabsList className="flex-wrap">
          {match && <TabsTrigger value="matching">Matching</TabsTrigger>}
          <TabsTrigger value="go-no-go">Go / No-go</TabsTrigger>
          <TabsTrigger value="resolucion">Resolución</TabsTrigger>
          {checklist && <TabsTrigger value="checklist">Checklist</TabsTrigger>}
        </TabsList>

        {match && (
          <TabsContent value="matching">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Matching</CardTitle>
                <CardDescription>Desglose del score contra el perfil de la empresa.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-display text-3xl font-bold tabular-nums text-foreground">{match.score}</span>
                  <span className="text-xs text-muted-foreground">de 100 · elegibilidad: {formatEligibility(match.eligibility.status)}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {match.criteria.map((c) => (
                    <div key={c.criterion} className="flex justify-between gap-3 border-b border-border pb-1 text-[13px]">
                      <span className="text-muted-foreground">{c.explanation}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">
                        {c.score}/{c.maxScore}
                      </span>
                    </div>
                  ))}
                </div>
                {match.eligibility.criteria.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {match.eligibility.criteria.map((c, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        {formatEligibility(c.status)}: {c.explanation}
                      </p>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="go-no-go">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Go / No-go</CardTitle>
              <CardDescription>Historial completo de decisiones y registro de una nueva.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {decisions.length === 0 && <p className="text-[13px] text-muted-foreground">Sin decisiones registradas todavía.</p>}
              {decisions.length > 0 && (
                <div className="flex flex-col gap-2">
                  {decisions.map((d) => (
                    <div key={d.id} className="rounded-xl border border-border p-3 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={d.decision === "go" ? "default" : "destructive"}>{d.decision === "go" ? "GO" : "NO-GO"}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(d.decidedAt)}</span>
                      </div>
                      <ul className="mt-1.5 list-disc pl-5 text-foreground">
                        {d.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        Score al decidir: {d.matchScore} · elegibilidad: {formatEligibility(d.matchEligibilityStatus)}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {GO_NO_GO_ROLES.has(role) ? (
                <div className="flex max-w-[460px] flex-col gap-2">
                  <Label htmlFor="go-no-go-motivos">Motivos (uno por línea)</Label>
                  <textarea
                    id="go-no-go-motivos"
                    value={reasonsText}
                    onChange={(e) => setReasonsText(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  {decisionError && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {decisionError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => void handleDecision("go")} disabled={submitting !== null}>
                      {submitting === "go" ? "Guardando…" : "Marcar Go"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleDecision("no_go")} disabled={submitting !== null}>
                      {submitting === "no_go" ? "Guardando…" : "Marcar No-go"}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede tomar decisiones go/no-go.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="resolucion">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resolución (ganada / perdida)</CardTitle>
              <CardDescription>Estado terminal de la convocatoria — el servidor revalida cada transición.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {resolutions.length > 0 && (
                <div className="flex flex-col gap-2">
                  {resolutions.map((r) => (
                    <div key={r.id} className="rounded-xl border border-border p-3 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={r.resolution === "won" ? "default" : "destructive"}>{r.resolution === "won" ? "GANADA" : "PERDIDA"}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(r.resolvedAt)}</span>
                      </div>
                      <p className="mt-1.5 text-foreground">{r.reason}</p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">Resuelta desde el estado "{formatTenderStatus(r.fromStatus)}".</p>
                    </div>
                  ))}
                </div>
              )}

              {tender.status === "won" || tender.status === "lost" ? (
                <p className="text-[13px] text-muted-foreground">
                  Esta convocatoria ya se resolvió como {tender.status === "won" ? "ganada" : "perdida"} -- es un estado terminal, no admite una nueva resolución.
                </p>
              ) : !RESOLUTION_ROLES.has(role) ? (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede marcar una convocatoria ganada/perdida (se requiere owner/admin/analyst).</p>
              ) : !RESOLVABLE_FROM_STATUSES.has(tender.status ?? "discovered") ? (
                <p className="text-[13px] text-muted-foreground">
                  Todavía no se puede resolver: se requiere una decisión "Go" primero (estado actual: "{formatTenderStatus(tender.status)}"). Nunca se salta directo de una convocatoria sin decisión a ganada/perdida.
                </p>
              ) : (
                <div className="flex max-w-[460px] flex-col gap-2">
                  <Label htmlFor="resolucion-motivo">Motivo</Label>
                  <textarea
                    id="resolucion-motivo"
                    value={resolutionReasonText}
                    onChange={(e) => setResolutionReasonText(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  {resolutionError && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {resolutionError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => void handleResolve("won")} disabled={resolvingAs !== null}>
                      {resolvingAs === "won" ? "Guardando…" : "Marcar ganada"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void handleResolve("lost")} disabled={resolvingAs !== null}>
                      {resolvingAs === "lost" ? "Guardando…" : "Marcar perdida"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {checklist && (
          <TabsContent value="checklist">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCheck2 className="h-4 w-4 text-muted-foreground" />
                  Checklist de integridad <ResultDot result={checklist.overallStatus} />
                </CardTitle>
                <CardDescription>Último resultado ya corrido — esta ficha nunca ejecuta el checklist.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {checklist.items.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Todavía no se ha corrido el checklist de esta convocatoria.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {checklist.items.map((item) => (
                      <div key={item.id} className="flex justify-between gap-3 border-b border-border pb-1.5 text-[13px]">
                        <div>
                          <p className="font-semibold text-foreground">{item.dimension}</p>
                          <p className="mt-0.5 text-muted-foreground">{item.notes}</p>
                        </div>
                        <ResultDot result={item.result} />
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Esta ficha solo muestra el último resultado ya corrido --{" "}
                  <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} className="font-semibold text-foreground hover:underline">
                    corre el checklist de nuevo o continúa el cierre aquí
                  </Link>
                  .
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
