// L-31 -- ciclo de licitaciones coherente para la API simulada de e2e: convocatoria -> go/no-go -> requisitos (extraidos del texto que se
// sube) -> propuesta tecnica/economica -> checklist -> aprobacion por seccion -> paquete -> contrato -> cobranza -> inconformidad.
// Cada escritura cambia el estado del escenario (aislado por prueba) y la lectura siguiente lo refleja. Replica las reglas de los
// servidores reales (roles WRITE/DECISION/GO_NO_GO/INCONFORMIDAD_REVIEW de domain-licitaciones, 409 de transiciones, step-up de
// pagado, plazo de 17 dias habiles de la factura) para que lo que la pantalla muestre sea lo que el API diria. Solo existe en la
// API simulada de e2e: ningun dato sale de aqui hacia la base ni a produccion.
import { conStatus, fallo } from "../respuestas.ts";
import { orgDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";

const ORG = orgDe("licitaciones");
const L = "/licitaciones/:id";

// Espejo de domain-licitaciones/src/roles.ts (el servidor es la autoridad; la SPA solo oculta lo que el servidor rechazaria).
export const ROLES_ESCRITURA = ["owner", "admin", "analyst", "writer", "reviewer"] as const;
export const ROLES_DECISION = ["owner", "admin", "analyst"] as const;
export const ROLES_GO_NO_GO = ["owner", "admin", "analyst", "reviewer"] as const;
export const ROLES_REVISION_INCONFORMIDAD = ["owner", "admin", "reviewer"] as const;

export const AHORA_CICLO = "2026-10-01T18:00:00.000Z";
export const CODIGO_STEP_UP = "123456";

type EstadoConvocatoria = "discovered" | "in_review" | "go" | "no_go" | "in_progress" | "submitted" | "won" | "lost" | "cancelled";

export interface ConvocatoriaMock {
  id: string;
  organizationId: string;
  title: string;
  submissionDeadline: string | null;
  updatedAt: string;
  source: string | null;
  externalId: string | null;
  contractingBody: string | null;
  cpvCodes: string[];
  budgetAmount: number | null;
  currency: string | null;
  state: string | null;
  procedureTypeRaw: string | null;
  status: EstadoConvocatoria | null;
}

export const CONVOCATORIAS_SEMILLA: readonly ConvocatoriaMock[] = [
  { id: "tnd-1", organizationId: ORG.id, title: "Rehabilitacion de la avenida Reforma, tramo norte", submissionDeadline: "2026-10-20T17:00:00.000Z", updatedAt: "2026-09-29T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E12-2026", contractingBody: "Secretaria de Obras Publicas de Yucatan", cpvCodes: ["45233120"], budgetAmount: 18500000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Licitacion publica nacional", status: "in_review" },
  { id: "tnd-2", organizationId: ORG.id, title: "Suministro de luminarias LED para alumbrado publico", submissionDeadline: "2026-10-27T17:00:00.000Z", updatedAt: "2026-09-30T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E15-2026", contractingBody: "Ayuntamiento de Merida", cpvCodes: ["34928500"], budgetAmount: 4200000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Invitacion a cuando menos tres personas", status: "discovered" },
];

interface DecisionMock { id: string; organizationId: string; tenderId: string; decision: "go" | "no_go"; reasons: string[]; matchScore: number; matchEligibilityStatus: string; matchInputsHash: string; decidedBy: string; decidedAt: string }
interface ResolucionMock { id: string; organizationId: string; tenderId: string; resolution: "won" | "lost"; fromStatus: EstadoConvocatoria; reason: string; resolvedBy: string; resolvedAt: string }
interface RequisitoMock { id: string; documentId: string | null; text: string; requirementKind: string; obligatoriedad: string; topicKey: string | null; requiredEvidence: string[]; extractedBy: "rule"; page: number | null; clause: string | null; responsibleRole: string; deadline: string | null; status: string; confidence: number | null }
interface MapeoMock { id: string; topicKey: string; kind: string; refKey: string; statementTemplate: string }
interface TarifaMock { id: string; concept: string; unitPrice: string; currency: "MXN"; approvalStatus: string; validFrom: string; validUntil: string | null }
interface CampoMock { id: string; contractDocumentId: string; fieldKey: string; extractedValue: string; sourcePage: number | null; sourceClause: string | null; confidence: number; status: "sugerido" | "confirmado" | "corregido"; confirmedValue: string | null; confirmedBy: string | null; confirmedAt: string | null; createdAt: string }
interface ContratoMock { id: string; organizationId: string; tenderId: string; status: string; endDate: string | null; contractNumber: string | null; hasRenewalOption: boolean; renewalOptionNotes: string | null; createdBy: string; createdAt: string; updatedAt: string }
interface HistorialMock { id: string; contractId: string; fromStatus: string | null; toStatus: string; reason: string; actorId: string; evidenceRef: string | null; createdAt: string }
interface FacturaMock { id: string; contractId: string; concepto: string; amount: string; invoiceVerifiedOn: string; dueDate: string; legalReference: string; paidAt: string | null; status: "pendiente" | "pagada" | "vencida"; createdBy: string; createdAt: string }
interface BorradorMock { id: string; tenderId: string; version: number; status: "borrador" | "revisado"; contentHash: string; hechos: string[]; agravios: string[]; pruebas: string[]; fundamentos: unknown[]; plazo: Record<string, unknown>; viability: "alta" | "media" | "baja"; viabilityRecommendation: string; disclaimer: string; reviewedBy: string | null; reviewedAt: string | null; createdBy: string; createdAt: string }
interface ItemChecklistMock { id: string; dimension: string; result: "verde" | "ambar" | "rojo"; notes: string; evidenceRef: string | null; checkedAt: string }

interface Ciclo {
  convocatorias: ConvocatoriaMock[];
  decisiones: Record<string, DecisionMock[]>;
  resoluciones: Record<string, ResolucionMock[]>;
  requisitos: Record<string, RequisitoMock[]>;
  mapeos: Record<string, MapeoMock>;
  propuestaGenerada: { tecnica: { usados: number; noAplica: { requirementId: string; reason: string }[] } | null; economica: Record<string, unknown> | null };
  checklist: { overallStatus: "verde" | "ambar" | "rojo"; items: ItemChecklistMock[] };
  seccionesAprobadas: string[];
  tarifas: TarifaMock[];
  contrato: ContratoMock | null;
  historial: HistorialMock[];
  documentos: { id: string; contractId: string; documentLabel: string; pageCount: number; uploadedBy: string; createdAt: string }[];
  campos: CampoMock[];
  facturas: FacturaMock[];
  borradores: BorradorMock[];
  seq: number;
}

const ciclo = (p: { readonly estado: { obtener<T>(clave: string, semilla: () => T): T } }): Ciclo =>
  p.estado.obtener<Ciclo>("lic.ciclo", () => ({
    convocatorias: CONVOCATORIAS_SEMILLA.map((c) => ({ ...c, cpvCodes: [...c.cpvCodes] })),
    decisiones: {},
    resoluciones: {},
    requisitos: {},
    mapeos: {},
    propuestaGenerada: { tecnica: null, economica: null },
    checklist: { overallStatus: "verde", items: [{ id: "chk-1", dimension: "formato", result: "verde", notes: "Todos los archivos cumplen el formato del portal.", evidenceRef: null, checkedAt: "2026-09-30T15:00:00.000Z" }] },
    seccionesAprobadas: [],
    tarifas: [{ id: "rate-1", concept: "Rehabilitacion de carpeta asfaltica por m2", unitPrice: "1500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01", validUntil: null }],
    contrato: null,
    historial: [],
    documentos: [],
    campos: [],
    facturas: [],
    borradores: [],
    seq: 0,
  }));

const siguiente = (c: Ciclo, prefijo: string): string => `${prefijo}-${++c.seq}`;
const NO_CONVOCATORIA = () => fallo(404, "Convocatoria no encontrada.");
const buscar = (c: Ciclo, id: string | undefined) => c.convocatorias.find((t) => t.id === id);

function decodificar(b64: unknown): string {
  return typeof b64 === "string" ? Buffer.from(b64, "base64").toString("utf8") : "";
}

function exigirIdempotencia(p: Peticion) {
  const k = p.cabeceras["idempotency-key"];
  return typeof k === "string" && k !== "" ? null : fallo(400, "Falta el header Idempotency-Key.");
}

// ---------------------------------------------------------------- convocatorias, matching, go/no-go, resolucion
function scoreDe(t: ConvocatoriaMock): number {
  return t.id === "tnd-1" ? 72 : t.id === "tnd-2" ? 55 : 40;
}
function matchDe(t: ConvocatoriaMock) {
  const score = scoreDe(t);
  return {
    tenderId: t.id,
    score,
    criteria: [
      { criterion: "classifiers", score: Math.round(score * 0.4), maxScore: 40, explanation: "Coincide el clasificador CPV con la especialidad de la empresa." },
      { criterion: "budget", score: Math.round(score * 0.3), maxScore: 30, explanation: "El presupuesto cae dentro del rango del perfil." },
    ],
    eligibility: { status: score >= 50 ? "cumple" : "no_evaluable", criteria: [{ requirement: "states", status: "cumple", explanation: "Opera en el estado de la convocatoria." }] },
  };
}

const rutasConvocatorias: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/tenders`, manejador: (p) => ({ tenders: ciclo(p).convocatorias }) },
  // "matching" debe ir antes de `tenders/:tid`: si no, el literal se leeria como un id de convocatoria.
  { metodo: "GET", patron: `${L}/tenders/matching`, manejador: (p) => ({ results: ciclo(p).convocatorias.map(matchDe) }) },
  {
    metodo: "POST",
    patron: `${L}/tenders`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      const b = (p.cuerpo ?? {}) as Record<string, unknown>;
      if (typeof b["title"] !== "string" || b["title"].trim() === "") return fallo(400, "title: se esperaba una cadena no vacia.");
      const previa = typeof b["externalId"] === "string" ? c.convocatorias.find((t) => t.externalId === b["externalId"]) : undefined;
      const datos = {
        title: b["title"].trim(),
        externalId: (b["externalId"] as string | null | undefined) ?? null,
        contractingBody: (b["contractingBody"] as string | null | undefined) ?? null,
        submissionDeadline: (b["submissionDeadline"] as string | null | undefined) ?? null,
        budgetAmount: (b["budgetAmount"] as number | null | undefined) ?? null,
        updatedAt: AHORA_CICLO,
      };
      if (previa) {
        Object.assign(previa, datos);
        return previa;
      }
      const nueva: ConvocatoriaMock = { id: `tnd-n${c.convocatorias.length + 1}`, organizationId: ORG.id, ...datos, source: "manual", cpvCodes: [], currency: "MXN", state: null, procedureTypeRaw: null, status: "discovered" };
      c.convocatorias.push(nueva);
      return conStatus(201, nueva);
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid`, manejador: (p) => buscar(ciclo(p), p.params["tid"]) ?? NO_CONVOCATORIA() },
  { metodo: "GET", patron: `${L}/tenders/:tid/matching`, manejador: (p) => { const t = buscar(ciclo(p), p.params["tid"]); return t ? matchDe(t) : NO_CONVOCATORIA(); } },
  { metodo: "GET", patron: `${L}/tenders/:tid/go-no-go`, manejador: (p) => ({ decisions: ciclo(p).decisiones[p.params["tid"]!] ?? [] }) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/go-no-go`,
    roles: ROLES_GO_NO_GO,
    manejador: (p) => {
      const c = ciclo(p);
      const t = buscar(c, p.params["tid"]);
      if (!t) return NO_CONVOCATORIA();
      const b = (p.cuerpo ?? {}) as { decision?: unknown; reasons?: unknown };
      if (b.decision !== "go" && b.decision !== "no_go") return fallo(400, "decision: se esperaba go | no_go.");
      if (!Array.isArray(b.reasons) || b.reasons.length === 0) return fallo(400, "reasons: se requiere al menos un motivo.");
      const m = matchDe(t);
      const d: DecisionMock = { id: siguiente(c, "gng"), organizationId: ORG.id, tenderId: t.id, decision: b.decision, reasons: b.reasons.map(String), matchScore: m.score, matchEligibilityStatus: m.eligibility.status, matchInputsHash: "hash-mock", decidedBy: p.persona!.id, decidedAt: AHORA_CICLO };
      (c.decisiones[t.id] ??= []).unshift(d);
      t.status = b.decision === "go" ? "go" : "no_go";
      return conStatus(201, d);
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/resolution`, manejador: (p) => ({ resolutions: ciclo(p).resoluciones[p.params["tid"]!] ?? [] }) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/resolution`,
    roles: ROLES_DECISION,
    manejador: (p) => {
      const c = ciclo(p);
      const t = buscar(c, p.params["tid"]);
      if (!t) return NO_CONVOCATORIA();
      const b = (p.cuerpo ?? {}) as { resolution?: unknown; reason?: unknown };
      if (b.resolution !== "won" && b.resolution !== "lost") return fallo(400, "resolution: se esperaba won | lost.");
      if (typeof b.reason !== "string" || b.reason.trim() === "") return fallo(400, "reason: obligatorio.");
      if (t.status !== "go" && t.status !== "in_progress" && t.status !== "submitted") return fallo(409, `No se puede resolver una convocatoria en estado "${t.status}".`);
      const r: ResolucionMock = { id: siguiente(c, "res"), organizationId: ORG.id, tenderId: t.id, resolution: b.resolution, fromStatus: t.status, reason: b.reason.trim(), resolvedBy: p.persona!.id, resolvedAt: AHORA_CICLO };
      (c.resoluciones[t.id] ??= []).unshift(r);
      t.status = b.resolution;
      return conStatus(201, t);
    },
  },
];

// ---------------------------------------------------------------- requisitos (extraidos del texto subido) y propuestas
/** Extractor de reglas simulado: una linea de las bases = un requisito. Un documento sin texto (escaneado) se excluye y se reporta. */
function clasificar(linea: string, indice: number, documentId: string): RequisitoMock {
  const t = linea.toLowerCase();
  let requirementKind = "tecnico";
  let obligatoriedad = "obligatorio";
  let topicKey: string | null = null;
  let requiredEvidence: string[] = [];
  if (t.includes("poder notarial")) { requirementKind = "legal"; topicKey = "poder_notarial"; requiredEvidence = ["poder notarial"]; }
  else if (t.includes("acta constitutiva")) { requirementKind = "legal"; topicKey = "acta_constitutiva"; requiredEvidence = ["acta constitutiva"]; }
  else if (t.startsWith("anexo")) { requirementKind = "anexo"; topicKey = `anexo_${indice + 1}`; requiredEvidence = ["anexo firmado"]; }
  else if (t.includes("precio") || t.includes("econ")) { requirementKind = "economico"; topicKey = "propuesta_economica"; requiredEvidence = ["propuesta economica"]; }
  else if (t.includes("en su caso") || t.includes("si aplica")) { obligatoriedad = "condicional"; }
  return { id: `req-${documentId}-${indice + 1}`, documentId, text: linea, requirementKind, obligatoriedad, topicKey, requiredEvidence, extractedBy: "rule", page: 1, clause: `${indice + 1}`, responsibleRole: "analyst", deadline: null, status: "pendiente", confidence: null };
}

const ETIQUETA_SECCION: Record<string, string> = { tecnico: "Propuesta técnica", legal: "Cumplimiento legal", administrativo: "Cumplimiento administrativo", anexo: "Anexos" };

const rutasRequisitosYPropuesta: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/tenders/:tid/requirements`, manejador: (p) => ({ items: ciclo(p).requisitos[p.params["tid"]!] ?? [] }) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/requirements/extract`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      const tid = p.params["tid"]!;
      if (!buscar(c, tid)) return NO_CONVOCATORIA();
      const falta = exigirIdempotencia(p);
      if (falta) return falta;
      const docs = ((p.cuerpo ?? {}) as { documents?: Array<Record<string, unknown>> }).documents;
      if (!Array.isArray(docs) || docs.length === 0) return fallo(400, "documents: se requiere al menos un documento.");
      const nuevos: RequisitoMock[] = [];
      const skippedDocuments: unknown[] = [];
      for (const d of docs) {
        const texto = decodificar(d["contentBase64"]).trim();
        const documentId = String(d["documentId"] ?? siguiente(c, "doc"));
        if (texto === "") {
          skippedDocuments.push({ documentId, documentLabel: String(d["documentLabel"] ?? ""), status: "requires_ocr", detail: null });
          continue;
        }
        texto.split("\n").map((l) => l.trim()).filter((l) => l !== "").forEach((l, i) => nuevos.push(clasificar(l, i, documentId.slice(0, 8))));
      }
      (c.requisitos[tid] ??= []).push(...nuevos);
      return { items: nuevos, conflicts: [], skippedDocuments };
    },
  },
  {
    metodo: "GET",
    patron: `${L}/tenders/:tid/proposal`,
    manejador: (p) => {
      const c = ciclo(p);
      const tid = p.params["tid"]!;
      if (!buscar(c, tid)) return NO_CONVOCATORIA();
      return {
        id: "prop-1", tenderId: tid, title: "Propuesta", ivaRate: 0.16,
        economicTotals: (c.propuestaGenerada.economica?.["totals"] as unknown) ?? null,
        generationReport: c.propuestaGenerada.tecnica || c.propuestaGenerada.economica
          ? { ...(c.propuestaGenerada.tecnica ? { technical: { usedCompanyDocumentIds: Array.from({ length: c.propuestaGenerada.tecnica.usados }, (_, i) => `doc-${i + 1}`), notApplicableRequirements: c.propuestaGenerada.tecnica.noAplica } } : {}), ...(c.propuestaGenerada.economica ? { economic: c.propuestaGenerada.economica } : {}) }
          : null,
        correlationId: null, createdAt: AHORA_CICLO,
      };
    },
  },
  {
    metodo: "PUT",
    patron: `${L}/requirement-mappings/:topic`,
    roles: ROLES_DECISION,
    manejador: (p) => {
      const c = ciclo(p);
      const b = (p.cuerpo ?? {}) as { kind?: unknown; refKey?: unknown; statementTemplate?: unknown };
      if (!["capability", "experience", "document", "signer"].includes(String(b.kind))) return fallo(400, "kind invalido.");
      if (typeof b.refKey !== "string" || b.refKey.trim() === "" || typeof b.statementTemplate !== "string" || b.statementTemplate.trim() === "") return fallo(400, "refKey y statementTemplate son obligatorios.");
      const topicKey = decodeURIComponent(p.params["topic"]!);
      const m: MapeoMock = { id: c.mapeos[topicKey]?.id ?? siguiente(c, "map"), topicKey, kind: String(b.kind), refKey: b.refKey, statementTemplate: b.statementTemplate };
      c.mapeos[topicKey] = m;
      return m;
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/proposal/technical/generate`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      const tid = p.params["tid"]!;
      if (!buscar(c, tid)) return NO_CONVOCATORIA();
      const falta = exigirIdempotencia(p);
      if (falta) return falta;
      const evaluaciones = ((p.cuerpo ?? {}) as { conditionEvaluations?: Record<string, boolean> }).conditionEvaluations ?? {};
      const relevantes = (c.requisitos[tid] ?? []).filter((r) => r.requirementKind !== "economico");
      const noAplica: { requirementId: string; reason: string }[] = [];
      let bloqueos = 0;
      let usados = 0;
      for (const r of relevantes) {
        if (r.obligatoriedad === "condicional") {
          if (evaluaciones[r.id] === false) { noAplica.push({ requirementId: r.id, reason: `Condición declarada como no aplicable: ${r.text}` }); continue; }
          if (evaluaciones[r.id] === undefined) { bloqueos++; continue; }
        }
        if (r.topicKey && c.mapeos[r.topicKey]) usados++;
        else if (r.topicKey) bloqueos++;
      }
      const claves = [...new Set(relevantes.map((r) => (r.requirementKind === "administrativo" || r.requirementKind === "legal" || r.requirementKind === "anexo" ? r.requirementKind : "tecnico")))];
      c.propuestaGenerada.tecnica = { usados, noAplica };
      return { sections: claves.map((k) => ({ sectionKey: `technical:${k}`, label: ETIQUETA_SECCION[k] ?? k })), blockers: bloqueos, notApplicableRequirements: noAplica, correlationId: null };
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/proposal/economic/generate`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      const tid = p.params["tid"]!;
      if (!buscar(c, tid)) return NO_CONVOCATORIA();
      const falta = exigirIdempotencia(p);
      if (falta) return falta;
      const filas = ((p.cuerpo ?? {}) as { lineItems?: Array<{ concept?: unknown; quantity?: unknown }> }).lineItems;
      if (!Array.isArray(filas) || filas.length === 0) return fallo(400, "lineItems: se requiere al menos un concepto.");
      const resueltos: Array<{ concept: string; quantity: number; unitPrice: string; subtotal: string; sourceRef: { kind: string; refId: string; capturedAt: string | null } }> = [];
      const bloqueados: Array<{ concept: string; status: "missing" | "blocked"; detail: string }> = [];
      for (const f of filas) {
        const concept = String(f.concept ?? "");
        const quantity = Number(f.quantity);
        const tarifa = c.tarifas.find((t) => t.concept === concept && t.approvalStatus === "aprobado");
        if (!tarifa) { bloqueados.push({ concept, status: "missing", detail: "No hay una tarifa aprobada y vigente para este concepto." }); continue; }
        const subtotal = (Number(tarifa.unitPrice) * quantity).toFixed(2);
        resueltos.push({ concept, quantity, unitPrice: tarifa.unitPrice, subtotal, sourceRef: { kind: "rate", refId: tarifa.id, capturedAt: null } });
      }
      let totals: Record<string, unknown> | null = null;
      if (bloqueados.length === 0) {
        const subtotal = resueltos.reduce((a, r) => a + Number(r.subtotal), 0);
        const iva = subtotal * 0.16;
        totals = { currency: "MXN", subtotal: subtotal.toFixed(2), ivaRate: 0.16, iva: iva.toFixed(2), total: (subtotal + iva).toFixed(2), totalInWords: "Total en letra (simulado)" };
      }
      c.propuestaGenerada.economica = { usedRateConcepts: resueltos.map((r) => r.concept), blockedLineItems: bloqueados, totals };
      const proposal = { id: "prop-1", tenderId: tid, title: "Propuesta", ivaRate: 0.16, economicTotals: totals, generationReport: { economic: c.propuestaGenerada.economica }, correlationId: null, createdAt: AHORA_CICLO };
      return { proposal, economic: { lineItems: resueltos, blockedLineItems: bloqueados, totals } };
    },
  },
  { metodo: "GET", patron: `${L}/company/rates`, manejador: (p) => ({ rates: ciclo(p).tarifas }) },
];

// ---------------------------------------------------------------- checklist, secciones, descarga del paquete
const rutasCierreCiclo: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/tenders/:tid/checklist`, manejador: (p) => (buscar(ciclo(p), p.params["tid"]) ? ciclo(p).checklist : NO_CONVOCATORIA()) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/checklist/run`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      if (!buscar(c, p.params["tid"])) return NO_CONVOCATORIA();
      const falta = exigirIdempotencia(p);
      if (falta) return falta;
      const b = (p.cuerpo ?? {}) as { files?: Array<{ filename: string; extension: string; sizeBytes: number }>; formatLimits?: { allowedExtensions: string[]; maxFileSizeBytes: number; maxUploadSlots: number }; requiredSignatures?: Array<{ role: string; userConfirmedSigned: boolean }>; presentAnnexRefs?: string[] };
      const files = b.files ?? [];
      const lim = b.formatLimits ?? { allowedExtensions: [], maxFileSizeBytes: 0, maxUploadSlots: 0 };
      const items: ItemChecklistMock[] = [];
      const fecha = AHORA_CICLO;
      const malos = files.filter((f) => !lim.allowedExtensions.includes(f.extension) || f.sizeBytes > lim.maxFileSizeBytes);
      items.push(malos.length > 0
        ? { id: siguiente(c, "chk"), dimension: "formato", result: "rojo", notes: `Archivos fuera de formato o de tamaño: ${malos.map((f) => f.filename).join(", ")}.`, evidenceRef: null, checkedAt: fecha }
        : { id: siguiente(c, "chk"), dimension: "formato", result: "verde", notes: "Todos los archivos cumplen el formato del portal.", evidenceRef: null, checkedAt: fecha });
      items.push(files.length > lim.maxUploadSlots
        ? { id: siguiente(c, "chk"), dimension: "espacios de carga", result: "rojo", notes: "Hay más archivos que espacios de carga del portal.", evidenceRef: null, checkedAt: fecha }
        : { id: siguiente(c, "chk"), dimension: "espacios de carga", result: "verde", notes: "Los archivos caben en los espacios de carga del portal.", evidenceRef: null, checkedAt: fecha });
      const sinFirma = (b.requiredSignatures ?? []).filter((s) => !s.userConfirmedSigned);
      items.push(sinFirma.length > 0
        ? { id: siguiente(c, "chk"), dimension: "firmas", result: "ambar", notes: `Falta confirmar la firma de: ${sinFirma.map((s) => s.role).join(", ")}.`, evidenceRef: null, checkedAt: fecha }
        : { id: siguiente(c, "chk"), dimension: "firmas", result: "verde", notes: "Todas las firmas requeridas están confirmadas.", evidenceRef: null, checkedAt: fecha });
      const anexos = (c.requisitos[p.params["tid"]!] ?? []).filter((r) => r.requirementKind === "anexo" && r.obligatoriedad === "obligatorio").map((r) => r.topicKey ?? r.id);
      const faltan = anexos.filter((a) => !(b.presentAnnexRefs ?? []).includes(a));
      items.push(faltan.length > 0
        ? { id: siguiente(c, "chk"), dimension: "anexos obligatorios", result: "rojo", notes: `Faltan anexos obligatorios: ${faltan.join(", ")}.`, evidenceRef: null, checkedAt: fecha }
        : { id: siguiente(c, "chk"), dimension: "anexos obligatorios", result: "verde", notes: "Todos los anexos obligatorios están presentes.", evidenceRef: null, checkedAt: fecha });
      const overallStatus = items.some((i) => i.result === "rojo") ? "rojo" : items.some((i) => i.result === "ambar") ? "ambar" : "verde";
      c.checklist = { overallStatus, items };
      return c.checklist;
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/proposal/sections/:seccion/approval`,
    roles: ROLES_DECISION,
    manejador: (p) => {
      const c = ciclo(p);
      if (!buscar(c, p.params["tid"])) return NO_CONVOCATORIA();
      const seccion = decodeURIComponent(p.params["seccion"]!);
      if (!/^(technical|economic):[a-z]+$/.test(seccion)) return fallo(400, "sectionKey invalido.");
      c.seccionesAprobadas.push(seccion);
      return conStatus(201, { id: siguiente(c, "apr"), scope: "section", scopeRef: seccion, status: "vigente", inputsHash: "hash-mock", decidedAt: AHORA_CICLO });
    },
  },
];

// ---------------------------------------------------------------- contrato, documentos, cobranza, inconformidad
// Espejo de CONTRACT_TRANSITIONS / CONTRACT_DECISION_TRANSITIONS / CONTRACT_STEP_UP_TRANSITIONS de domain-licitaciones.
const TRANSICIONES: Record<string, readonly string[]> = {
  adjudicado: ["contrato_firmado_declarado", "en_inconformidad", "rescindido"],
  contrato_firmado_declarado: ["en_ejecucion", "modificado", "rescindido", "en_inconformidad"],
  en_ejecucion: ["entregado", "modificado", "penalizado", "rescindido"],
  entregado: ["facturado", "modificado", "penalizado"],
  facturado: ["pagado", "penalizado"],
  pagado: ["cerrado"],
  modificado: ["en_ejecucion", "entregado", "facturado", "pagado", "penalizado", "rescindido"],
  penalizado: ["en_ejecucion", "entregado", "facturado", "pagado", "rescindido"],
  rescindido: ["cerrado"],
  en_inconformidad: ["adjudicado", "contrato_firmado_declarado", "cerrado"],
  cerrado: [],
};
const TRANSICIONES_DECISION = ["rescindido", "penalizado", "en_inconformidad", "modificado"];
const TRANSICIONES_STEP_UP = ["rescindido", "penalizado", "en_inconformidad", "modificado", "pagado"];
const SIN_CONTRATO = () => fallo(404, "No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");

/** 17 dias habiles desde la verificacion (Art. 73 LAASSP vigente), sin calendario de inhabiles: solo fines de semana. */
function vencimiento(desde: string): string {
  const d = new Date(`${desde}T12:00:00Z`);
  let n = 0;
  while (n < 17) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dia = d.getUTCDay();
    if (dia !== 0 && dia !== 6) n++;
  }
  return d.toISOString().slice(0, 10);
}

const CAMPOS_CONTRATO: ReadonlyArray<[RegExp, string]> = [[/^n[uú]mero de contrato:\s*(.+)$/i, "numero_contrato"], [/^monto total:\s*(.+)$/i, "monto_total"], [/^plazo de entrega:\s*(.+)$/i, "plazo_entrega"]];

const rutasContrato: readonly Ruta[] = [
  { metodo: "POST", patron: `${L}/tenders/:tid/contract`, roles: ROLES_ESCRITURA, manejador: (p) => {
      const c = ciclo(p);
      const t = buscar(c, p.params["tid"]);
      if (!t) return NO_CONVOCATORIA();
      if (c.contrato) return fallo(409, "Ya existe un contrato para esta convocatoria.");
      c.contrato = { id: "ctr-1", organizationId: ORG.id, tenderId: t.id, status: "adjudicado", endDate: null, contractNumber: null, hasRenewalOption: false, renewalOptionNotes: null, createdBy: p.persona!.id, createdAt: AHORA_CICLO, updatedAt: AHORA_CICLO };
      c.historial.push({ id: siguiente(c, "his"), contractId: "ctr-1", fromStatus: null, toStatus: "adjudicado", reason: "Contrato registrado.", actorId: p.persona!.id, evidenceRef: null, createdAt: AHORA_CICLO });
      return conStatus(201, c.contrato);
    } },
  { metodo: "GET", patron: `${L}/tenders/:tid/contract`, manejador: (p) => (!buscar(ciclo(p), p.params["tid"]) ? NO_CONVOCATORIA() : (ciclo(p).contrato ?? SIN_CONTRATO())) },
  { metodo: "PATCH", patron: `${L}/tenders/:tid/contract`, roles: ROLES_ESCRITURA, manejador: (p) => {
      const c = ciclo(p);
      if (!c.contrato) return SIN_CONTRATO();
      const b = (p.cuerpo ?? {}) as Record<string, unknown>;
      if ("endDate" in b && b["endDate"] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b["endDate"]))) return fallo(400, 'endDate: se esperaba "YYYY-MM-DD" o null.');
      for (const k of ["endDate", "contractNumber", "hasRenewalOption", "renewalOptionNotes"] as const) if (k in b) (c.contrato as unknown as Record<string, unknown>)[k] = b[k];
      c.contrato.updatedAt = AHORA_CICLO;
      return c.contrato;
    } },
  { metodo: "GET", patron: `${L}/tenders/:tid/contract/history`, manejador: (p) => (ciclo(p).contrato ? { history: ciclo(p).historial } : SIN_CONTRATO()) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/contract/transition`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      if (!c.contrato) return SIN_CONTRATO();
      const b = (p.cuerpo ?? {}) as { toStatus?: string; reason?: string; evidenceRef?: string | null };
      const destino = String(b.toStatus ?? "");
      if (!(destino in TRANSICIONES)) return fallo(400, "toStatus invalido.");
      if (typeof b.reason !== "string" || b.reason.trim() === "") return fallo(400, "reason: obligatorio.");
      if (TRANSICIONES_DECISION.includes(destino) && !(ROLES_DECISION as readonly string[]).includes(p.persona!.rol)) return fallo(403, "Tu rol no permite esta accion");
      if (!TRANSICIONES[c.contrato.status]!.includes(destino)) return conStatus(409, { message: `Transición inválida: ${c.contrato.status} → ${destino}.`, allowedNextStates: TRANSICIONES[c.contrato.status] });
      if (TRANSICIONES_STEP_UP.includes(destino) && p.cabeceras["x-step-up-token"] !== `mock-step-up.${p.persona!.id}`) return fallo(403, "Esta acción requiere confirmar tu identidad con el código de tu app de autenticación.");
      c.historial.push({ id: siguiente(c, "his"), contractId: c.contrato.id, fromStatus: c.contrato.status, toStatus: destino, reason: b.reason.trim(), actorId: p.persona!.id, evidenceRef: b.evidenceRef ?? null, createdAt: AHORA_CICLO });
      c.contrato.status = destino;
      c.contrato.updatedAt = AHORA_CICLO;
      return c.contrato;
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/contract/documents`, manejador: (p) => (ciclo(p).contrato ? { documents: ciclo(p).documentos } : SIN_CONTRATO()) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/contract/documents`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      if (!c.contrato) return SIN_CONTRATO();
      const b = (p.cuerpo ?? {}) as { documentLabel?: string; contentBase64?: string };
      const texto = decodificar(b.contentBase64);
      if (texto.trim() === "") return fallo(422, "El documento no tiene texto extraíble.");
      const document = { id: siguiente(c, "cdoc"), contractId: c.contrato.id, documentLabel: String(b.documentLabel ?? ""), pageCount: 1, uploadedBy: p.persona!.id, createdAt: AHORA_CICLO };
      c.documentos.push(document);
      const fields: CampoMock[] = [];
      texto.split("\n").forEach((linea, i) => {
        for (const [patron, fieldKey] of CAMPOS_CONTRATO) {
          const m = patron.exec(linea.trim());
          if (m) fields.push({ id: siguiente(c, "fld"), contractDocumentId: document.id, fieldKey, extractedValue: m[1]!.trim(), sourcePage: 1, sourceClause: `línea ${i + 1}`, confidence: 0.9, status: "sugerido", confirmedValue: null, confirmedBy: null, confirmedAt: null, createdAt: AHORA_CICLO });
        }
      });
      c.campos.push(...fields);
      return conStatus(201, { document, fields });
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/contract/documents/:did/fields`, manejador: (p) => ({ fields: ciclo(p).campos.filter((f) => f.contractDocumentId === p.params["did"]) }) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/contract/fields/:fid/confirm`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const campo = ciclo(p).campos.find((f) => f.id === p.params["fid"]);
      if (!campo) return fallo(404, "Campo no encontrado.");
      const b = (p.cuerpo ?? {}) as { action?: string; correctedValue?: string | null };
      if (b.action === "correct") {
        if (!b.correctedValue) return fallo(400, "correctedValue: obligatorio al corregir.");
        campo.status = "corregido";
        campo.confirmedValue = b.correctedValue;
      } else if (b.action === "confirm") {
        campo.status = "confirmado";
        campo.confirmedValue = campo.extractedValue;
      } else return fallo(400, "action: se esperaba confirm | correct.");
      campo.confirmedBy = p.persona!.id;
      campo.confirmedAt = AHORA_CICLO;
      return campo;
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/contract/invoices`, manejador: (p) => (ciclo(p).contrato ? { invoices: ciclo(p).facturas } : fallo(404, "No existe contrato registrado para esta convocatoria.")) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/contract/invoices`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      if (!c.contrato) return fallo(404, "No existe contrato registrado para esta convocatoria.");
      const b = (p.cuerpo ?? {}) as { concepto?: string; amount?: string; invoiceVerifiedOn?: string };
      if (!b.concepto || !b.concepto.trim()) return fallo(400, "concepto: obligatorio.");
      if (!/^\d+(\.\d{1,2})?$/.test(String(b.amount))) return fallo(400, "amount: se esperaba un decimal positivo.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.invoiceVerifiedOn))) return fallo(400, "invoiceVerifiedOn: se esperaba YYYY-MM-DD.");
      const f: FacturaMock = { id: siguiente(c, "inv"), contractId: c.contrato.id, concepto: b.concepto.trim(), amount: String(b.amount), invoiceVerifiedOn: b.invoiceVerifiedOn!, dueDate: vencimiento(b.invoiceVerifiedOn!), legalReference: "Art. 73 LAASSP (17 días hábiles)", paidAt: null, status: "pendiente", createdBy: p.persona!.id, createdAt: AHORA_CICLO };
      c.facturas.push(f);
      return conStatus(201, f);
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/contract/invoices/:iid/mark-paid`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const f = ciclo(p).facturas.find((x) => x.id === p.params["iid"]);
      if (!f) return fallo(404, "Factura no encontrada.");
      f.status = "pagada";
      f.paidAt = AHORA_CICLO;
      return f;
    },
  },
  {
    metodo: "GET",
    patron: `${L}/tenders/:tid/contract/receivables`,
    manejador: (p) => {
      const c = ciclo(p);
      if (!c.contrato) return fallo(404, "No existe contrato registrado para esta convocatoria.");
      const asOfDate = AHORA_CICLO.slice(0, 10);
      const abiertas = c.facturas.filter((f) => f.status !== "pagada");
      const vencidas = abiertas.filter((f) => f.dueDate < asOfDate);
      const suma = (l: FacturaMock[]) => l.reduce((a, f) => a + Number(f.amount), 0).toFixed(2);
      return { asOfDate, totalPending: suma(abiertas), totalOverdue: suma(vencidas), countPending: abiertas.length, countOverdue: vencidas.length, invoices: c.facturas.map((f) => ({ ...f, status: f.status === "pendiente" && f.dueDate < asOfDate ? "vencida" : f.status })) };
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/inconformidad`, manejador: (p) => ({ drafts: ciclo(p).borradores }) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/inconformidad`,
    roles: ROLES_ESCRITURA,
    manejador: (p) => {
      const c = ciclo(p);
      const b = (p.cuerpo ?? {}) as { hechos?: string[]; agravios?: string[]; pruebas?: string[]; falloNotifiedOn?: string; bajoTratados?: boolean };
      if (!b.hechos?.length || !b.agravios?.length) return fallo(400, "hechos y agravios: se requiere al menos uno.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.falloNotifiedOn))) return fallo(400, "falloNotifiedOn: se esperaba YYYY-MM-DD.");
      const d: BorradorMock = {
        id: siguiente(c, "inc"), tenderId: p.params["tid"]!, version: c.borradores.length + 1, status: "borrador", contentHash: "hash-mock", hechos: b.hechos, agravios: b.agravios, pruebas: b.pruebas ?? [],
        fundamentos: [{ articulo: "65", ley: "LAASSP", jurisdiccion: "federal", fechaDof: null, texto: "Procede la inconformidad contra el fallo." }],
        plazo: { diasHabiles: 6, fechaNotificacionFallo: b.falloNotifiedOn, fechaLimite: vencimiento(b.falloNotifiedOn!), fundamentoLegal: "Art. 65 LAASSP", bajoTratados: b.bajoTratados === true },
        viability: (b.pruebas?.length ?? 0) > 0 ? "media" : "baja", viabilityRecommendation: (b.pruebas?.length ?? 0) > 0 ? "Hay pruebas: revisar con abogado." : "Sin pruebas la viabilidad es baja.",
        disclaimer: "Borrador de apoyo: no constituye asesoría legal.", reviewedBy: null, reviewedAt: null, createdBy: p.persona!.id, createdAt: AHORA_CICLO,
      };
      c.borradores.unshift(d);
      return conStatus(201, d);
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/inconformidad/:did/review`,
    roles: ROLES_REVISION_INCONFORMIDAD,
    manejador: (p) => {
      const d = ciclo(p).borradores.find((x) => x.id === p.params["did"]);
      if (!d) return fallo(404, "Borrador no encontrado.");
      d.status = "revisado";
      d.reviewedBy = p.persona!.id;
      d.reviewedAt = AHORA_CICLO;
      return d;
    },
  },
];

/** Ruta de descarga del paquete (la lectura/ensamblado viven en licitaciones.ts junto al estado de la doble aprobacion). */
export const rutasCiclo: readonly Ruta[] = [...rutasConvocatorias, ...rutasRequisitosYPropuesta, ...rutasCierreCiclo, ...rutasContrato];

export { ciclo as estadoCiclo };
