// Autopsia del fallo (Fase 16 pieza propia) — cierra la penúltima porción del
// hallazgo ALTA de auditoría "Post-adjudicación completa (contratos,
// documentos, cobranza, inconformidades, autopsia, renovaciones) = 22 rutas
// sin UI": SOLO autopsia del fallo aquí (falloAutopsy.ts, ver
// lib/autopsia-client.ts) -- generar/ver la autopsia de una convocatoria
// perdida (por qué se perdió, causas raíz comparando la propuesta propia
// contra el fallo) y ver las lecciones aprendidas agregadas de TODAS las
// convocatorias pasadas, vinculadas al perfil de empresa. Se llega aquí
// desde ConvocatoriaDetalle.tsx cuando `tender.status === "lost"` -- mismo
// criterio exacto que el enlace a Contrato.tsx cuando es "won".
//
// Deliberadamente FUERA de esta pieza (alcance de otro agente en paralelo,
// ver README de este vertical): el radar de renovaciones -- no se construye
// ni se referencia desde aquí.
//
// Dos bloques independientes:
//  1. Alta de una autopsia más (el servidor nunca limita a una sola por
//     convocatoria -- pueden registrarse varias revisiones a lo largo del
//     tiempo) + historial de las ya registradas para ESTA convocatoria.
//  2. Lecciones aprendidas ORG-WIDE (todas las convocatorias, no solo esta)
//     -- de solo lectura, el servidor las deriva de las autopsias creadas,
//     nunca se editan aquí directamente.
//
// Fase "sistema de diseño real" (contenido) — los `sectionCardStyle`/
// `inputStyle`/`primaryButtonStyle` inline pasan a `Card`/`Input`/`Button` de
// @atiende/ui, el pill de estatus a `Badge` y los estados de carga/error a
// `EstadoCargando`/`EstadoError`. Cero cambios de lógica ni de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { createFalloAutopsy, fetchFalloAutopsies, fetchLessonsLearned, OWN_PROPOSAL_STATUSES } from "../lib/autopsia-client.ts";
import type { CompanyLessonLearnedRecord, CriteriaComparisonItem, FalloAutopsyRecord, OwnProposalStatus } from "../lib/autopsia-client.ts";
import { formatDate, formatMoney, formatOwnProposalStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que el resto del vertical (WRITE_ROLES de
// `@atiende/domain-licitaciones::roles.ts`) -- cosmético, oculta lo que el
// servidor rechazaría igual (`assertVerticalRole(c, WRITE_ROLES)` en
// `falloAutopsy.ts`).
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

/** `<select>`/`<textarea>` siguen siendo nativos (el sistema no exporta un
 * primitivo propio para ellos): solo se restilan con los tokens reales. */
const CAMPO_NATIVO =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const OWN_PROPOSAL_STATUS_VARIANTS: Record<OwnProposalStatus, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  ganadora: { variant: "default" },
  desechada: { variant: "destructive" },
  no_presentada: { variant: "outline", className: "border-amber-500/60 text-amber-600 dark:text-amber-400" },
  desconocido: { variant: "secondary" },
};

function StatusBadge({ status }: { status: OwnProposalStatus }) {
  const cfg = OWN_PROPOSAL_STATUS_VARIANTS[status];
  return (
    <Badge variant={cfg.variant} className={cfg.className}>
      {formatOwnProposalStatus(status)}
    </Badge>
  );
}

function emptyCriteriaRow(): CriteriaComparisonItem {
  return { criterio: "", propio: "", ganador: "" };
}

export function AutopsiaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [autopsies, setAutopsies] = useState<readonly FalloAutopsyRecord[]>([]);
  const [lessons, setLessons] = useState<readonly CompanyLessonLearnedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Formulario de alta.
  const [ownProposalStatus, setOwnProposalStatus] = useState<OwnProposalStatus>("desconocido");
  const [disqualificationReason, setDisqualificationReason] = useState("");
  const [ownScore, setOwnScore] = useState("");
  const [winnerScore, setWinnerScore] = useState("");
  const [ownPrice, setOwnPrice] = useState("");
  const [winnerPrice, setWinnerPrice] = useState("");
  const [winnerName, setWinnerName] = useState("");
  const [criteria, setCriteria] = useState<CriteriaComparisonItem[]>([emptyCriteriaRow()]);
  const [lessonsText, setLessonsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, autopsiesData, lessonsData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchFalloAutopsies(fetch, apiBaseUrl, token, propertyId, id),
        fetchLessonsLearned(fetch, apiBaseUrl, token, propertyId),
      ]);
      setTender(tenderData);
      setAutopsies(autopsiesData);
      setLessons(lessonsData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la autopsia del fallo.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  function parseOptionalNumber(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  function updateCriteriaRow(index: number, patch: Partial<CriteriaComparisonItem>) {
    setCriteria((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeCriteriaRow(index: number) {
    setCriteria((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const lessonsList = lessonsText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const criteriaComparison = criteria.filter((row) => row.criterio.trim().length > 0);
      await createFalloAutopsy(fetch, apiBaseUrl, token, propertyId, tenderId, {
        ownProposalStatus,
        disqualificationReason: disqualificationReason.trim().length > 0 ? disqualificationReason.trim() : null,
        ownScore: parseOptionalNumber(ownScore),
        winnerScore: parseOptionalNumber(winnerScore),
        ownPrice: parseOptionalNumber(ownPrice),
        winnerPrice: parseOptionalNumber(winnerPrice),
        winnerName: winnerName.trim().length > 0 ? winnerName.trim() : null,
        criteriaComparison,
        lessons: lessonsList,
      });
      setOwnProposalStatus("desconocido");
      setDisqualificationReason("");
      setOwnScore("");
      setWinnerScore("");
      setOwnPrice("");
      setWinnerPrice("");
      setWinnerName("");
      setCriteria([emptyCriteriaRow()]);
      setLessonsText("");
      await load(tenderId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "No se pudo registrar la autopsia.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando autopsia del fallo…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  const canWrite = WRITE_ROLES.has(role);

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Autopsia del fallo</h1>
        <p className="text-[13px] text-muted-foreground">
          Por qué se perdió esta convocatoria y qué lección deja -- las lecciones quedan vinculadas al perfil de la empresa, consultables en cualquier convocatoria futura.
        </p>
      </div>

      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Registrar autopsia</CardTitle>
            <CardDescription>El servidor no limita a una sola por convocatoria: pueden registrarse varias revisiones.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="autopsia-estatus">Estatus de nuestra propuesta</Label>
                <select id="autopsia-estatus" value={ownProposalStatus} onChange={(e) => setOwnProposalStatus(e.target.value as OwnProposalStatus)} className={`${CAMPO_NATIVO} h-11`}>
                  {OWN_PROPOSAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {formatOwnProposalStatus(s)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="autopsia-motivo">Motivo de desechamiento (si aplica)</Label>
                <textarea
                  id="autopsia-motivo"
                  value={disqualificationReason}
                  onChange={(e) => setDisqualificationReason(e.target.value)}
                  rows={2}
                  placeholder="Se deja «no disponible» si no se capturó nada"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="autopsia-own-score">Nuestro puntaje</Label>
                  <Input id="autopsia-own-score" type="number" min={0} value={ownScore} onChange={(e) => setOwnScore(e.target.value)} placeholder="Sin declarar" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="autopsia-winner-score">Puntaje del ganador</Label>
                  <Input id="autopsia-winner-score" type="number" min={0} value={winnerScore} onChange={(e) => setWinnerScore(e.target.value)} placeholder="Sin declarar" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="autopsia-own-price">Nuestro precio</Label>
                  <Input id="autopsia-own-price" type="number" min={0} value={ownPrice} onChange={(e) => setOwnPrice(e.target.value)} placeholder="Sin declarar" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="autopsia-winner-price">Precio del ganador</Label>
                  <Input id="autopsia-winner-price" type="number" min={0} value={winnerPrice} onChange={(e) => setWinnerPrice(e.target.value)} placeholder="Sin declarar" />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="autopsia-winner-name">Nombre del ganador (si el fallo es público)</Label>
                  <Input id="autopsia-winner-name" value={winnerName} onChange={(e) => setWinnerName(e.target.value)} placeholder="Sin declarar" />
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-foreground">Comparación por criterio (opcional)</p>
                <div className="flex flex-col gap-2">
                  {criteria.map((row, index) => (
                    <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                      <Input value={row.criterio} onChange={(e) => updateCriteriaRow(index, { criterio: e.target.value })} placeholder="Criterio" aria-label={`Criterio ${index + 1}`} />
                      <Input value={row.propio} onChange={(e) => updateCriteriaRow(index, { propio: e.target.value })} placeholder="Nuestro resultado" aria-label={`Nuestro resultado ${index + 1}`} />
                      <Input value={row.ganador} onChange={(e) => updateCriteriaRow(index, { ganador: e.target.value })} placeholder="Resultado del ganador" aria-label={`Resultado del ganador ${index + 1}`} />
                      <Button type="button" variant="outline" size="sm" onClick={() => removeCriteriaRow(index)} disabled={criteria.length <= 1}>
                        <Trash2 />
                        Quitar
                      </Button>
                    </div>
                  ))}
                </div>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setCriteria((prev) => [...prev, emptyCriteriaRow()])}>
                  <Plus />
                  Agregar criterio
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="autopsia-lecciones">Lecciones aprendidas (una por línea)</Label>
                <textarea
                  id="autopsia-lecciones"
                  value={lessonsText}
                  onChange={(e) => setLessonsText(e.target.value)}
                  rows={3}
                  placeholder={"Ej.: pedir la constancia de cumplimiento con 2 semanas de anticipación"}
                  className={CAMPO_NATIVO}
                />
              </div>

              {submitError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {submitError}
                </p>
              )}
              <Button type="submit" size="sm" className="self-start" disabled={submitting}>
                {submitting ? "Guardando…" : "Guardar autopsia"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede registrar una autopsia del fallo.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Autopsias registradas ({autopsies.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {autopsies.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Todavía no se ha registrado ninguna autopsia para esta convocatoria.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {autopsies
                .slice()
                .reverse()
                .map((a) => (
                  <div key={a.id} className="rounded-xl border border-border p-3 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <StatusBadge status={a.ownProposalStatus} />
                      <span className="text-[11px] text-muted-foreground">{formatDate(a.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-foreground">
                      <strong>Motivo:</strong> {a.disqualificationReason}
                    </p>
                    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
                      <p className="text-muted-foreground">
                        Puntaje: {a.ownScore ?? "s/d"} vs {a.winnerScore ?? "s/d"}
                      </p>
                      <p className="text-muted-foreground">
                        Precio: {a.ownPrice !== null ? formatMoney(a.ownPrice, null) : "s/d"} vs {a.winnerPrice !== null ? formatMoney(a.winnerPrice, null) : "s/d"}
                      </p>
                      <p className="text-muted-foreground">Ganador: {a.winnerName}</p>
                    </div>
                    {a.criteriaComparison.length > 0 && (
                      <div className="mt-2">
                        <p className="mb-1 text-xs font-semibold text-foreground">Comparación por criterio</p>
                        <div className="flex flex-col gap-1">
                          {a.criteriaComparison.map((c, i) => (
                            <div key={i} className="text-xs text-muted-foreground">
                              <strong className="text-foreground">{c.criterio}:</strong> nosotros «{c.propio}» · ganador «{c.ganador}»
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lecciones aprendidas de la empresa ({lessons.length})</CardTitle>
          <CardDescription>Agregadas de TODAS las convocatorias de esta organización, no solo esta -- de solo lectura.</CardDescription>
        </CardHeader>
        <CardContent>
          {lessons.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Todavía no hay lecciones registradas.</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 pl-5">
              {lessons
                .slice()
                .reverse()
                .map((l) => (
                  <li key={l.id} className="text-[13px] text-foreground">
                    {l.lessonText}
                    <span className="text-[11px] text-muted-foreground"> — {formatDate(l.createdAt)}</span>
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
