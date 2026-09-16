// Propuesta técnica + económica + mapeo de cumplimiento (Fase 12/13, piezas
// acotadas) — cierra el hallazgo ALTA de auditoría: "Siguiente paso natural
// [tras RequisitosConvocatoria.tsx]: generación de la propuesta técnica.
// technicalProposal.ts expone POST .../proposal/technical/generate y
// PUT .../requirement-mappings/:topicKey (DECISION_ROLES) -- ninguno tiene
// cliente ni página." y su continuación (Fase 13): "Siguiente paso natural
// tras la propuesta técnica: propuesta económica. proposalEconomic.ts expone
// GET .../proposal y POST .../economic/generate -- ninguno tiene cliente ni
// página."
//
// Alcance DELIBERADAMENTE acotado a esto: a partir de los requisitos YA
// extraídos (RequisitosConvocatoria.tsx), (1) declarar explícitamente si
// cada requisito CONDICIONAL aplica al caso concreto, (2) generar la
// propuesta técnica (`TechnicalProposalBuilder`, persiste
// `licitaciones.proposal_section`) y ver el resumen (secciones generadas,
// bloqueos, requisitos marcados "no aplica"), (3) mapear/editar cada
// `topicKey` a su dato de empresa (DECISION_ROLES) -- decisión editorial/de
// riesgo sobre qué se afirma ante un ente público, y (4, Fase 13) generar la
// propuesta económica (`EconomicProposalBuilder`) a partir de una lista de
// conceptos + cantidad capturada a mano, gateada por WRITE_ROLES (mismo rol
// que exige el servidor en `proposal/economic/generate`) -- ninguna
// restricción de orden entre (2) y (4): el backend no exige que exista una
// propuesta técnica generada para aceptar la económica (dominios
// independientes: requisitos técnicos vs. tarifas aprobadas), esta pantalla
// simplemente las presenta en el orden natural del flujo. El checklist de
// integridad ejecutable, las aprobaciones y el ZIP de cierre YA tienen
// pantalla propia (Fase 14, `pages/Cierre.tsx` + `lib/cierre-client.ts`,
// enlazada abajo) -- solo lo post-adjudicación (contratos, cobranza,
// inconformidades) queda FUERA de esta pieza, alcance de rondas futuras (ver
// README de este vertical).
//
// El backend NO expone todavía un `GET .../requirement-mappings` -- solo el
// PUT (upsert). Esta pantalla no puede, entonces, precargar el mapeo
// guardado en una sesión ANTERIOR: solo confirma el que el usuario acaba de
// enviar en ESTA sesión (ver `technical-proposal-client.ts`). Añadir ese GET
// es trabajo de otra pieza -- no se inventa aquí.
//
// Fase "sistema de diseño real" (contenido) — las secciones pasan a `Card`,
// los inputs/selects a `Input`/`Label` (los `<select>` siguen nativos,
// restilados con tokens), todos los botones a `Button`, y los bloques de
// resultado azul/ámbar hardcodeados a superficies de token. Cero cambios de
// lógica ni de red.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchRequirementItems } from "../lib/requirements-client.ts";
import type { RequirementItemRecord } from "../lib/requirements-client.ts";
import { fetchOrCreateProposal, generateEconomicProposal, generateTechnicalProposal, upsertRequirementMapping } from "../lib/technical-proposal-client.ts";
import type {
  EconomicLineItemInput,
  GenerateEconomicProposalResult,
  GenerateTechnicalProposalResult,
  ProposalRecord,
  RequirementFulfillmentMappingKind,
  RequirementFulfillmentMappingRecord,
} from "../lib/technical-proposal-client.ts";
import { formatRequirementKind, formatObligatoriedad } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que Convocatorias.tsx/RequisitosConvocatoria.tsx
// (WRITE_ROLES de `@atiende/domain-licitaciones::roles.ts`) -- cosmético,
// oculta el botón de generar a quien el servidor rechazaría igual
// (`assertVerticalRole(c, WRITE_ROLES)` en `proposal/technical/generate`).
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

// DECISION_ROLES EXACTO de `@atiende/domain-licitaciones::roles.ts` (más
// estricto que WRITE_ROLES: sin "writer"/"reviewer") -- oculta el formulario
// de mapeo a quien el servidor rechazaría igual
// (`assertVerticalRole(c, DECISION_ROLES)` en `PUT .../requirement-mappings/:topicKey`).
const DECISION_ROLES = new Set(["owner", "admin", "analyst"]);

// Idéntico a `relevantTypes` en `TechnicalProposalBuilder.build`
// (domain-licitaciones/src/technical-proposal.ts) -- "economico" nunca entra
// a la propuesta técnica.
const TECHNICAL_RELEVANT_TYPES = new Set(["tecnico", "administrativo", "legal", "anexo"]);

const MAPPING_KIND_OPTIONS: ReadonlyArray<{ value: RequirementFulfillmentMappingKind; label: string }> = [
  { value: "document", label: "Documento de empresa" },
  { value: "capability", label: "Capacidad / especialidad" },
  { value: "experience", label: "Experiencia previa" },
  { value: "signer", label: "Firmante autorizado" },
];

type ConditionChoice = "sin_evaluar" | "aplica" | "no_aplica";

interface MappingFormState {
  kind: RequirementFulfillmentMappingKind;
  refKey: string;
  statementTemplate: string;
}

const EMPTY_MAPPING_FORM: MappingFormState = { kind: "document", refKey: "", statementTemplate: "" };

/** `<select>` sigue siendo nativo (el sistema no exporta un primitivo propio):
 * solo se restila con los tokens reales, mismo anillo de foco que `Input`. */
const SELECT_NATIVO =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Panel de resultado informativo (antes azul #eff6ff hardcodeado). */
const PANEL_INFO = "flex flex-col gap-2 rounded-xl border border-border bg-muted p-3";
/** Panel de resultado bloqueado/advertencia (antes ámbar #fffbeb hardcodeado). */
const PANEL_ALERTA = "flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3";
const TEXTO_ALERTA = "text-amber-700 dark:text-amber-400";
const ENLACE_SECUNDARIO = "inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-foreground no-underline hover:underline";

export function PropuestaTecnicaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();

  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [items, setItems] = useState<readonly RequirementItemRecord[] | null>(null);
  const [proposal, setProposal] = useState<ProposalRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [conditionChoices, setConditionChoices] = useState<Record<string, ConditionChoice>>({});

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateResult, setGenerateResult] = useState<GenerateTechnicalProposalResult | null>(null);

  const [mappingForms, setMappingForms] = useState<Record<string, MappingFormState>>({});
  const [savingTopicKey, setSavingTopicKey] = useState<string | null>(null);
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({});
  const [savedMappings, setSavedMappings] = useState<Record<string, RequirementFulfillmentMappingRecord>>({});

  // Fase 13 — propuesta económica: filas capturadas a mano (concepto + texto
  // de cantidad, sin parsear todavía -- se valida recién al enviar, mismo
  // criterio que el resto del formulario).
  const [economicRows, setEconomicRows] = useState<{ concept: string; quantity: string }[]>([{ concept: "", quantity: "1" }]);
  const [economicGenerating, setEconomicGenerating] = useState(false);
  const [economicError, setEconomicError] = useState<string | null>(null);
  const [economicResult, setEconomicResult] = useState<GenerateEconomicProposalResult["economic"] | null>(null);

  const canGenerate = WRITE_ROLES.has(role);
  const canMap = DECISION_ROLES.has(role);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, itemsData, proposalData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchRequirementItems(fetch, apiBaseUrl, token, propertyId, id),
        fetchOrCreateProposal(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setTender(tenderData);
      setItems(itemsData);
      setProposal(proposalData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
    // eslint: mismo criterio que el resto del panel (este proyecto no tiene
    // eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId, tenderId]);

  const technicalItems = useMemo(() => (items ?? []).filter((i) => TECHNICAL_RELEVANT_TYPES.has(i.requirementKind)), [items]);
  const conditionalItems = useMemo(() => technicalItems.filter((i) => i.obligatoriedad === "condicional"), [technicalItems]);

  /** Un `topicKey` -> uno o más requisitos que lo comparten (varios requisitos de bases distintas pueden apuntar al mismo tema, p. ej. "acta_constitutiva"). */
  const itemsByTopicKey = useMemo(() => {
    const map = new Map<string, RequirementItemRecord[]>();
    for (const item of technicalItems) {
      if (!item.topicKey) continue;
      const list = map.get(item.topicKey) ?? [];
      list.push(item);
      map.set(item.topicKey, list);
    }
    return map;
  }, [technicalItems]);

  function mappingFormFor(topicKey: string): MappingFormState {
    return mappingForms[topicKey] ?? EMPTY_MAPPING_FORM;
  }

  function updateMappingForm(topicKey: string, patch: Partial<MappingFormState>) {
    setMappingForms((prev) => ({ ...prev, [topicKey]: { ...mappingFormFor(topicKey), ...patch } }));
  }

  async function handleGenerate() {
    if (!tenderId) return;
    setGenerateError(null);
    setGenerateResult(null);
    const conditionEvaluations: Record<string, boolean> = {};
    for (const [requirementId, choice] of Object.entries(conditionChoices)) {
      if (choice === "aplica") conditionEvaluations[requirementId] = true;
      else if (choice === "no_aplica") conditionEvaluations[requirementId] = false;
    }
    setGenerating(true);
    try {
      const result = await generateTechnicalProposal(fetch, apiBaseUrl, token, propertyId, tenderId, conditionEvaluations);
      setGenerateResult(result);
      // Refleja el nuevo generationReport (usedCompanyDocumentIds, etc.) sin
      // recargar toda la página -- mismo criterio que RequisitosConvocatoria.tsx
      // recargando `items` tras un `extractRequirements` exitoso.
      const refreshedProposal = await fetchOrCreateProposal(fetch, apiBaseUrl, token, propertyId, tenderId);
      setProposal(refreshedProposal);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "No se pudo generar la propuesta técnica.");
    } finally {
      setGenerating(false);
    }
  }

  function updateEconomicRow(index: number, patch: Partial<{ concept: string; quantity: string }>) {
    setEconomicRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addEconomicRow() {
    setEconomicRows((prev) => [...prev, { concept: "", quantity: "1" }]);
  }

  function removeEconomicRow(index: number) {
    setEconomicRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleGenerateEconomic() {
    if (!tenderId) return;
    setEconomicError(null);
    setEconomicResult(null);

    // Validación cliente-side, espejo de `parseLineItems` en
    // `proposalEconomic.ts` -- el servidor la vuelve a hacer igual (nunca se
    // confía en esta), pero un error explícito aquí evita un roundtrip vacío.
    const lineItems: EconomicLineItemInput[] = [];
    for (const [i, row] of economicRows.entries()) {
      const concept = row.concept.trim();
      if (concept.length === 0) {
        setEconomicError(`Fila ${i + 1}: el concepto es obligatorio.`);
        return;
      }
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setEconomicError(`Fila ${i + 1}: la cantidad debe ser un número mayor a 0.`);
        return;
      }
      lineItems.push({ concept, quantity });
    }

    setEconomicGenerating(true);
    try {
      const result = await generateEconomicProposal(fetch, apiBaseUrl, token, propertyId, tenderId, lineItems);
      setEconomicResult(result.economic);
      setProposal(result.proposal);
    } catch (err) {
      setEconomicError(err instanceof Error ? err.message : "No se pudo generar la propuesta económica.");
    } finally {
      setEconomicGenerating(false);
    }
  }

  async function handleSaveMapping(event: FormEvent<HTMLFormElement>, topicKey: string) {
    event.preventDefault();
    const form = mappingFormFor(topicKey);
    setMappingErrors((prev) => ({ ...prev, [topicKey]: "" }));
    if (form.refKey.trim().length === 0) {
      setMappingErrors((prev) => ({ ...prev, [topicKey]: "El identificador de referencia (refKey) es obligatorio." }));
      return;
    }
    if (form.statementTemplate.trim().length === 0) {
      setMappingErrors((prev) => ({ ...prev, [topicKey]: 'La plantilla de redacción es obligatoria (usa "{value}" para insertar el dato real).' }));
      return;
    }
    setSavingTopicKey(topicKey);
    try {
      const saved = await upsertRequirementMapping(fetch, apiBaseUrl, token, propertyId, topicKey, {
        kind: form.kind,
        refKey: form.refKey.trim(),
        statementTemplate: form.statementTemplate.trim(),
      });
      setSavedMappings((prev) => ({ ...prev, [topicKey]: saved }));
    } catch (err) {
      setMappingErrors((prev) => ({ ...prev, [topicKey]: err instanceof Error ? err.message : "No se pudo guardar el mapeo." }));
    } finally {
      setSavingTopicKey(null);
    }
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando propuesta…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  const priorTechnical = proposal?.generationReport?.technical;
  const priorEconomic = proposal?.generationReport?.economic;

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title} · requisitos
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Propuesta técnica</h1>
        <p className="text-[13px] text-muted-foreground">
          Genera la propuesta técnica a partir de los requisitos ya extraídos y configura a qué dato de empresa se redacta cada tema (topicKey). La propuesta económica vive abajo en esta misma pantalla.
        </p>
        <div className="mt-2 flex flex-col gap-1">
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} className={ENLACE_SECUNDARIO}>
            Correr checklist, aprobar y ensamblar el paquete de cierre →
          </Link>
          <Link to={`/licitaciones/${orgSlug}/datos-empresa`} className={ENLACE_SECUNDARIO}>
            Capturar/aprobar documentos, tarifas, capacidades, experiencia y firmantes de la empresa →
          </Link>
        </div>
      </div>

      {technicalItems.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          Todavía no hay requisitos técnicos/legales/administrativos/de anexo extraídos para esta convocatoria.{" "}
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} className="font-semibold text-foreground hover:underline">
            Sube las bases primero
          </Link>
          .
        </p>
      )}

      {technicalItems.length > 0 && (
        <>
          {conditionalItems.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Requisitos condicionales ({conditionalItems.length})</CardTitle>
                <CardDescription>
                  Declara si cada condición aplica a este caso concreto. Sin evaluar, el requisito se trata como obligatorio por precaución (fail-closed) y queda bloqueado hasta que lo confirmes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  {conditionalItems.map((item) => {
                    const choice = conditionChoices[item.id] ?? "sin_evaluar";
                    return (
                      <div key={item.id} className="rounded-xl border border-border p-2.5">
                        <p className="mb-2 text-[13px] text-foreground">{item.text}</p>
                        <div className="flex flex-wrap gap-4 text-xs">
                          {(["sin_evaluar", "aplica", "no_aplica"] as const).map((option) => (
                            <label key={option} className="flex cursor-pointer items-center gap-1.5 text-foreground">
                              <input
                                type="radio"
                                name={`condicion-${item.id}`}
                                checked={choice === option}
                                onChange={() => setConditionChoices((prev) => ({ ...prev, [item.id]: option }))}
                                className="h-4 w-4 accent-[hsl(var(--primary))]"
                              />
                              {option === "sin_evaluar" ? "Sin evaluar" : option === "aplica" ? "Sí aplica" : "No aplica"}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generar propuesta técnica</CardTitle>
              <CardDescription>
                Redacta una sección por categoría (técnica, legal, administrativa, anexos) usando datos de empresa APROBADOS y el mapeo configurado abajo. Un requisito sin dato mapeado/aprobado queda "PENDIENTE:" en su sección -- nunca se inventa contenido.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {priorTechnical && (
                <p className="text-xs text-muted-foreground">
                  Última generación registrada: {priorTechnical.usedCompanyDocumentIds?.length ?? 0} dato(s) de empresa usado(s)
                  {priorTechnical.notApplicableRequirements && priorTechnical.notApplicableRequirements.length > 0 ? `, ${priorTechnical.notApplicableRequirements.length} requisito(s) marcado(s) "no aplica"` : ""}.
                </p>
              )}

              {canGenerate ? (
                <Button type="button" size="sm" className="self-start" onClick={() => void handleGenerate()} disabled={generating}>
                  <Sparkles />
                  {generating ? "Generando…" : "Generar propuesta técnica"}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede generar la propuesta técnica -- solo lectura.</p>
              )}

              {generateError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {generateError}
                </p>
              )}

              {generateResult && (
                <div className={PANEL_INFO}>
                  <p className="text-[13px] font-semibold text-foreground">
                    {generateResult.sections.length} sección(es) generada(s) · {generateResult.blockers} bloqueo(s) pendiente(s)
                  </p>
                  {generateResult.sections.length > 0 && (
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {generateResult.sections.map((s) => (
                        <li key={s.sectionKey}>{s.label}</li>
                      ))}
                    </ul>
                  )}
                  {generateResult.blockers > 0 && (
                    <p className={`text-xs ${TEXTO_ALERTA}`}>
                      Hay requisitos sin dato mapeado/aprobado o condiciones sin evaluar -- revisa el mapeo abajo o las condiciones arriba y vuelve a generar.
                    </p>
                  )}
                  {generateResult.notApplicableRequirements.length > 0 && (
                    <div>
                      <p className="mb-0.5 text-xs font-semibold text-foreground">Marcados "no aplica":</p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                        {generateResult.notApplicableRequirements.map((n) => (
                          <li key={n.requirementId}>{n.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Mapeo de requisitos a decisión ({itemsByTopicKey.size})</CardTitle>
              <CardDescription>
                Para cada tema (topicKey) detectado en los requisitos, decide de qué dato de empresa se redacta y con qué texto. Es una decisión editorial/de riesgo (afecta qué se afirma ante el ente público) -- guardar reemplaza cualquier mapeo previo de ese tema.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {itemsByTopicKey.size === 0 && (
                <p className="text-[13px] text-muted-foreground">Ningún requisito extraído trae un topicKey identificado todavía -- no hay nada que mapear.</p>
              )}

              {!canMap && itemsByTopicKey.size > 0 && (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede configurar el mapeo de cumplimiento -- solo DECISION_ROLES (owner/admin/analyst).</p>
              )}

              {[...itemsByTopicKey.entries()].map(([topicKey, relatedItems]) => {
                const form = mappingFormFor(topicKey);
                const saved = savedMappings[topicKey];
                const error = mappingErrors[topicKey];
                const saving = savingTopicKey === topicKey;
                return (
                  <div key={topicKey} className="flex flex-col gap-2 rounded-xl border border-border p-3">
                    <div>
                      <p className="text-[13px] font-semibold text-foreground">{topicKey}</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                        {relatedItems.slice(0, 3).map((i) => (
                          <li key={i.id}>
                            {i.text} <span className="text-muted-foreground/70">({formatRequirementKind(i.requirementKind)} · {formatObligatoriedad(i.obligatoriedad)})</span>
                          </li>
                        ))}
                        {relatedItems.length > 3 && <li>+{relatedItems.length - 3} más con este mismo tema…</li>}
                      </ul>
                    </div>

                    {saved && (
                      <p role="status" className="text-xs font-medium text-green-600 dark:text-green-500">
                        Guardado: {MAPPING_KIND_OPTIONS.find((o) => o.value === saved.kind)?.label ?? saved.kind} · refKey "{saved.refKey}".
                      </p>
                    )}

                    {canMap && (
                      <form onSubmit={(e) => void handleSaveMapping(e, topicKey)} className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <div className="flex flex-[1_1_160px] flex-col gap-1.5">
                            <Label htmlFor={`mapeo-kind-${topicKey}`}>Fuente del dato</Label>
                            <select
                              id={`mapeo-kind-${topicKey}`}
                              value={form.kind}
                              onChange={(e) => updateMappingForm(topicKey, { kind: e.target.value as RequirementFulfillmentMappingKind })}
                              className={SELECT_NATIVO}
                            >
                              {MAPPING_KIND_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex flex-[1_1_200px] flex-col gap-1.5">
                            <Label htmlFor={`mapeo-refkey-${topicKey}`}>Identificador (refKey)</Label>
                            <Input
                              id={`mapeo-refkey-${topicKey}`}
                              value={form.refKey}
                              onChange={(e) => updateMappingForm(topicKey, { refKey: e.target.value })}
                              placeholder={form.kind === "document" ? "acta_constitutiva" : form.kind === "signer" ? "representante_legal" : "nombre o id"}
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`mapeo-plantilla-${topicKey}`}>Plantilla de redacción (usa "{"{value}"}" para el dato real)</Label>
                          <Input
                            id={`mapeo-plantilla-${topicKey}`}
                            value={form.statementTemplate}
                            onChange={(e) => updateMappingForm(topicKey, { statementTemplate: e.target.value })}
                            placeholder="Se acompaña acta constitutiva vigente: {value}."
                          />
                        </div>
                        {error && (
                          <p role="alert" className="text-xs text-destructive">
                            {error}
                          </p>
                        )}
                        <Button type="submit" variant="outline" size="sm" className="self-start" disabled={saving}>
                          {saving ? "Guardando…" : saved ? "Actualizar mapeo" : "Guardar mapeo"}
                        </Button>
                      </form>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Propuesta económica</CardTitle>
          <CardDescription>
            Captura los conceptos y cantidades de esta propuesta. Cada concepto se resuelve contra las tarifas APROBADAS y vigentes a la fecha del acto -- un solo concepto sin tarifa resoluble bloquea el total completo, nunca se muestra un total parcial.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {priorEconomic && priorEconomic.totals && (
            <p className="text-xs text-muted-foreground">
              Última generación registrada: total ${priorEconomic.totals.total} {priorEconomic.totals.currency} ({priorEconomic.usedRateConcepts?.length ?? 0} concepto(s)).
            </p>
          )}
          {priorEconomic && !priorEconomic.totals && (priorEconomic.blockedLineItems?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">Última generación registrada: quedó bloqueada por conceptos sin tarifa resoluble.</p>
          )}

          {canGenerate ? (
            <>
              <div className="flex flex-col gap-2">
                {economicRows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-[3_1_220px] flex-col gap-1.5">
                      <Label htmlFor={`economico-concepto-${index}`}>Concepto</Label>
                      <Input
                        id={`economico-concepto-${index}`}
                        value={row.concept}
                        onChange={(e) => updateEconomicRow(index, { concept: e.target.value })}
                        placeholder="Servicio de limpieza"
                      />
                    </div>
                    <div className="flex flex-[1_1_100px] flex-col gap-1.5">
                      <Label htmlFor={`economico-cantidad-${index}`}>Cantidad</Label>
                      <Input
                        id={`economico-cantidad-${index}`}
                        type="number"
                        min="0"
                        step="any"
                        value={row.quantity}
                        onChange={(e) => updateEconomicRow(index, { quantity: e.target.value })}
                      />
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => removeEconomicRow(index)} disabled={economicRows.length <= 1}>
                      <Trash2 />
                      Quitar
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={addEconomicRow}>
                  <Plus />
                  Agregar concepto
                </Button>
              </div>

              <Button type="button" size="sm" className="self-start" onClick={() => void handleGenerateEconomic()} disabled={economicGenerating}>
                <Sparkles />
                {economicGenerating ? "Generando…" : "Generar propuesta económica"}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede generar la propuesta económica -- solo lectura.</p>
          )}

          {economicError && (
            <p role="alert" className="text-[13px] text-destructive">
              {economicError}
            </p>
          )}

          {economicResult && economicResult.totals && (
            <div className={PANEL_INFO}>
              <p className="text-[13px] font-semibold text-foreground">
                Subtotal: ${economicResult.totals.subtotal} · IVA ({(economicResult.totals.ivaRate * 100).toFixed(0)}%): ${economicResult.totals.iva} · Total: ${economicResult.totals.total} {economicResult.totals.currency}
              </p>
              <p className="text-xs text-muted-foreground">{economicResult.totals.totalInWords}</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {economicResult.lineItems.map((li, i) => (
                  <li key={`${li.concept}-${i}`}>
                    {li.concept} · cantidad {li.quantity} · precio unitario ${li.unitPrice} · subtotal ${li.subtotal}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {economicResult && !economicResult.totals && (
            <div className={PANEL_ALERTA}>
              <p className={`text-[13px] font-semibold ${TEXTO_ALERTA}`}>
                Sin total: {economicResult.blockedLineItems.length} concepto(s) sin tarifa aprobada/vigente. Corrige el concepto o registra la tarifa y vuelve a generar.
              </p>
              <ul className={`list-disc pl-5 text-xs ${TEXTO_ALERTA}`}>
                {economicResult.blockedLineItems.map((b, i) => (
                  <li key={`${b.concept}-${i}`}>
                    {b.concept}: {b.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
