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
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
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

const sectionCardStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };

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

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (loadError) return <p role="alert" style={{ color: "#b91c1c" }}>{loadError}</p>;
  if (!tender) return null;

  const priorTechnical = proposal?.generationReport?.technical;
  const priorEconomic = proposal?.generationReport?.economic;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title} · requisitos
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Propuesta técnica</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Genera la propuesta técnica a partir de los requisitos ya extraídos y configura a qué dato de empresa se redacta cada tema (topicKey). La propuesta económica vive abajo en esta misma pantalla.
        </p>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} style={{ display: "inline-block", marginTop: 8, fontSize: 13, color: "#111827", fontWeight: 600, textDecoration: "none" }}>
          Correr checklist, aprobar y ensamblar el paquete de cierre →
        </Link>
      </div>

      {technicalItems.length === 0 && (
        <p style={{ fontSize: 13, color: "#6b7280" }}>
          Todavía no hay requisitos técnicos/legales/administrativos/de anexo extraídos para esta convocatoria.{" "}
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} style={{ color: "#111827", fontWeight: 600 }}>
            Sube las bases primero
          </Link>
          .
        </p>
      )}

      {technicalItems.length > 0 && (
        <>
          {conditionalItems.length > 0 && (
            <section style={sectionCardStyle}>
              <div>
                <h2 style={{ fontSize: 15, margin: 0 }}>Requisitos condicionales ({conditionalItems.length})</h2>
                <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                  Declara si cada condición aplica a este caso concreto. Sin evaluar, el requisito se trata como obligatorio por precaución (fail-closed) y queda bloqueado hasta que lo confirmes.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {conditionalItems.map((item) => {
                  const choice = conditionChoices[item.id] ?? "sin_evaluar";
                  return (
                    <div key={item.id} style={{ border: "1px solid #f3f4f6", borderRadius: 8, padding: 10 }}>
                      <p style={{ margin: "0 0 8px", fontSize: 13 }}>{item.text}</p>
                      <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
                        {(["sin_evaluar", "aplica", "no_aplica"] as const).map((option) => (
                          <label key={option} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                            <input
                              type="radio"
                              name={`condicion-${item.id}`}
                              checked={choice === option}
                              onChange={() => setConditionChoices((prev) => ({ ...prev, [item.id]: option }))}
                            />
                            {option === "sin_evaluar" ? "Sin evaluar" : option === "aplica" ? "Sí aplica" : "No aplica"}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section style={sectionCardStyle}>
            <div>
              <h2 style={{ fontSize: 15, margin: 0 }}>Generar propuesta técnica</h2>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                Redacta una sección por categoría (técnica, legal, administrativa, anexos) usando datos de empresa APROBADOS y el mapeo configurado abajo. Un requisito sin dato mapeado/aprobado queda "PENDIENTE:" en su sección -- nunca se inventa contenido.
              </p>
            </div>

            {priorTechnical && (
              <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
                Última generación registrada: {priorTechnical.usedCompanyDocumentIds?.length ?? 0} dato(s) de empresa usado(s)
                {priorTechnical.notApplicableRequirements && priorTechnical.notApplicableRequirements.length > 0 ? `, ${priorTechnical.notApplicableRequirements.length} requisito(s) marcado(s) "no aplica"` : ""}.
              </p>
            )}

            {canGenerate ? (
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={generating}
                style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                {generating ? "Generando…" : "Generar propuesta técnica"}
              </button>
            ) : (
              <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede generar la propuesta técnica -- solo lectura.</p>
            )}

            {generateError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {generateError}
              </p>
            )}

            {generateResult && (
              <div style={{ border: "1px solid #dbeafe", background: "#eff6ff", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1e40af" }}>
                  {generateResult.sections.length} sección(es) generada(s) · {generateResult.blockers} bloqueo(s) pendiente(s)
                </p>
                {generateResult.sections.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#1e3a8a" }}>
                    {generateResult.sections.map((s) => (
                      <li key={s.sectionKey}>{s.label}</li>
                    ))}
                  </ul>
                )}
                {generateResult.blockers > 0 && (
                  <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>
                    Hay requisitos sin dato mapeado/aprobado o condiciones sin evaluar -- revisa el mapeo abajo o las condiciones arriba y vuelve a generar.
                  </p>
                )}
                {generateResult.notApplicableRequirements.length > 0 && (
                  <div>
                    <p style={{ margin: "4px 0 2px", fontSize: 12, fontWeight: 600, color: "#1e3a8a" }}>Marcados "no aplica":</p>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#1e3a8a" }}>
                      {generateResult.notApplicableRequirements.map((n) => (
                        <li key={n.requirementId}>{n.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section style={sectionCardStyle}>
            <div>
              <h2 style={{ fontSize: 15, margin: 0 }}>Mapeo de requisitos a decisión ({itemsByTopicKey.size})</h2>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                Para cada tema (topicKey) detectado en los requisitos, decide de qué dato de empresa se redacta y con qué texto. Es una decisión editorial/de riesgo (afecta qué se afirma ante el ente público) -- guardar reemplaza cualquier mapeo previo de ese tema.
              </p>
            </div>

            {itemsByTopicKey.size === 0 && (
              <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Ningún requisito extraído trae un topicKey identificado todavía -- no hay nada que mapear.</p>
            )}

            {!canMap && itemsByTopicKey.size > 0 && (
              <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede configurar el mapeo de cumplimiento -- solo DECISION_ROLES (owner/admin/analyst).</p>
            )}

            {[...itemsByTopicKey.entries()].map(([topicKey, relatedItems]) => {
              const form = mappingFormFor(topicKey);
              const saved = savedMappings[topicKey];
              const error = mappingErrors[topicKey];
              const saving = savingTopicKey === topicKey;
              return (
                <div key={topicKey} style={{ border: "1px solid #f3f4f6", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{topicKey}</p>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, color: "#6b7280" }}>
                      {relatedItems.slice(0, 3).map((i) => (
                        <li key={i.id}>
                          {i.text} <span style={{ color: "#9ca3af" }}>({formatRequirementKind(i.requirementKind)} · {formatObligatoriedad(i.obligatoriedad)})</span>
                        </li>
                      ))}
                      {relatedItems.length > 3 && <li>+{relatedItems.length - 3} más con este mismo tema…</li>}
                    </ul>
                  </div>

                  {saved && (
                    <p role="status" style={{ margin: 0, fontSize: 12, color: "#166534" }}>
                      Guardado: {MAPPING_KIND_OPTIONS.find((o) => o.value === saved.kind)?.label ?? saved.kind} · refKey "{saved.refKey}".
                    </p>
                  )}

                  {canMap && (
                    <form onSubmit={(e) => void handleSaveMapping(e, topicKey)} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 160px" }}>
                          Fuente del dato
                          <select value={form.kind} onChange={(e) => updateMappingForm(topicKey, { kind: e.target.value as RequirementFulfillmentMappingKind })} style={inputStyle}>
                            {MAPPING_KIND_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 200px" }}>
                          Identificador (refKey)
                          <input
                            value={form.refKey}
                            onChange={(e) => updateMappingForm(topicKey, { refKey: e.target.value })}
                            placeholder={form.kind === "document" ? "acta_constitutiva" : form.kind === "signer" ? "representante_legal" : "nombre o id"}
                            style={inputStyle}
                          />
                        </label>
                      </div>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                        Plantilla de redacción (usa "{"{value}"}" para el dato real)
                        <input
                          value={form.statementTemplate}
                          onChange={(e) => updateMappingForm(topicKey, { statementTemplate: e.target.value })}
                          placeholder="Se acompaña acta constitutiva vigente: {value}."
                          style={inputStyle}
                        />
                      </label>
                      {error && (
                        <p role="alert" style={{ margin: 0, fontSize: 12, color: "#b91c1c" }}>
                          {error}
                        </p>
                      )}
                      <button
                        type="submit"
                        disabled={saving}
                        style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 6, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      >
                        {saving ? "Guardando…" : saved ? "Actualizar mapeo" : "Guardar mapeo"}
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Propuesta económica</h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            Captura los conceptos y cantidades de esta propuesta. Cada concepto se resuelve contra las tarifas APROBADAS y vigentes a la fecha del acto -- un solo concepto sin tarifa resoluble bloquea el total completo, nunca se muestra un total parcial.
          </p>
        </div>

        {priorEconomic && priorEconomic.totals && (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
            Última generación registrada: total ${priorEconomic.totals.total} {priorEconomic.totals.currency} ({priorEconomic.usedRateConcepts?.length ?? 0} concepto(s)).
          </p>
        )}
        {priorEconomic && !priorEconomic.totals && (priorEconomic.blockedLineItems?.length ?? 0) > 0 && (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Última generación registrada: quedó bloqueada por conceptos sin tarifa resoluble.</p>
        )}

        {canGenerate ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {economicRows.map((row, index) => (
                <div key={index} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "3 1 220px" }}>
                    Concepto
                    <input
                      value={row.concept}
                      onChange={(e) => updateEconomicRow(index, { concept: e.target.value })}
                      placeholder="Servicio de limpieza"
                      style={inputStyle}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 100px" }}>
                    Cantidad
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={row.quantity}
                      onChange={(e) => updateEconomicRow(index, { quantity: e.target.value })}
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeEconomicRow(index)}
                    disabled={economicRows.length <= 1}
                    style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", cursor: economicRows.length <= 1 ? "not-allowed" : "pointer", fontSize: 12 }}
                  >
                    Quitar
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addEconomicRow}
                style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                + Agregar concepto
              </button>
            </div>

            <button
              type="button"
              onClick={() => void handleGenerateEconomic()}
              disabled={economicGenerating}
              style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {economicGenerating ? "Generando…" : "Generar propuesta económica"}
            </button>
          </>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede generar la propuesta económica -- solo lectura.</p>
        )}

        {economicError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {economicError}
          </p>
        )}

        {economicResult && economicResult.totals && (
          <div style={{ border: "1px solid #dbeafe", background: "#eff6ff", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1e40af" }}>
              Subtotal: ${economicResult.totals.subtotal} · IVA ({(economicResult.totals.ivaRate * 100).toFixed(0)}%): ${economicResult.totals.iva} · Total: ${economicResult.totals.total} {economicResult.totals.currency}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: "#1e3a8a" }}>{economicResult.totals.totalInWords}</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#1e3a8a" }}>
              {economicResult.lineItems.map((li, i) => (
                <li key={`${li.concept}-${i}`}>
                  {li.concept} · cantidad {li.quantity} · precio unitario ${li.unitPrice} · subtotal ${li.subtotal}
                </li>
              ))}
            </ul>
          </div>
        )}

        {economicResult && !economicResult.totals && (
          <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#92400e" }}>
              Sin total: {economicResult.blockedLineItems.length} concepto(s) sin tarifa aprobada/vigente. Corrige el concepto o registra la tarifa y vuelve a generar.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
              {economicResult.blockedLineItems.map((b, i) => (
                <li key={`${b.concept}-${i}`}>
                  {b.concept}: {b.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
