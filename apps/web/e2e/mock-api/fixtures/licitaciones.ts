// Fixtures de licitaciones (Constructora Peninsular). Forma = apps/web/src/verticals/licitaciones/lib/*-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("licitaciones");
const ORG = orgDe("licitaciones");
const L = "/licitaciones/:id";

const CONVOCATORIAS = [
  { id: "tnd-1", organizationId: ORG.id, title: "Rehabilitacion de la avenida Reforma, tramo norte", submissionDeadline: "2026-10-20T17:00:00.000Z", updatedAt: "2026-09-29T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E12-2026", contractingBody: "Secretaria de Obras Publicas de Yucatan", cpvCodes: ["45233120"], budgetAmount: 18500000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Licitacion publica nacional", status: "in_review" },
  { id: "tnd-2", organizationId: ORG.id, title: "Suministro de luminarias LED para alumbrado publico", submissionDeadline: "2026-10-27T17:00:00.000Z", updatedAt: "2026-09-30T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E15-2026", contractingBody: "Ayuntamiento de Merida", cpvCodes: ["34928500"], budgetAmount: 4200000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Invitacion a cuando menos tres personas", status: "discovered" },
];

interface AjustesWhatsapp {
  available: boolean;
  configured: boolean;
  contact: { phoneE164: string; status: string; notifyPlazos: boolean; notifyConvocatorias: boolean; notifyFallos: boolean; notifyDecisiones: boolean } | null;
  events: Array<{ id: string; event: string; detail: string | null; createdAt: string }>;
}

function ajustesSemilla(): AjustesWhatsapp {
  return {
    available: true,
    configured: true,
    contact: { phoneE164: "+529995550501", status: "activo", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: false },
    events: [{ id: "evt-1", event: "confirmado", detail: null, createdAt: "2026-09-25T16:00:00.000Z" }],
  };
}

// CHAT-12 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). El servidor real deja pasar a todo rol de la vertical, asi que la API simulada no
// restringe por rol. Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const BLOQUE_SEMAFORO = {
  kind: "table",
  tool: "plazos_semaforo",
  title: "Plazos y semáforo",
  columns: [
    { key: "semaforo", label: "Semáforo", kind: "text" },
    { key: "convocatorias", label: "Convocatorias", kind: "integer" },
  ],
  rows: [
    { semaforo: "Rojo", convocatorias: 1 },
    { semaforo: "Amarillo", convocatorias: 2 },
    { semaforo: "Verde", convocatorias: 4 },
  ],
  chart: { kind: "bar", x: "semaforo", y: "convocatorias" },
  truncated: false,
};
const TEXTO_SEMAFORO = "Tienes 7 convocatorias abiertas: 1 en rojo, 2 en amarillo y 4 en verde.";
const FUENTE_SEMAFORO = { tool: "plazos_semaforo", source: "Convocatorias de la organización con fecha límite vigente", periodLabel: "hoy", scopeLabel: "toda tu organización" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("licitaciones.copiloto.conversaciones", () => []);

const rutasCopiloto: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/chat-datos/pins`, manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "GET", patron: `${L}/chat-datos/estado`, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${L}/chat-datos`,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { question?: string; label?: string; conversationId?: string };
      const pregunta = String(cuerpo.question ?? cuerpo.label ?? "");
      const lista = conversacionesMock(p);
      let conv = lista.find((c) => c.id === cuerpo.conversationId);
      if (!conv) {
        conv = { id: `00000000-0000-4000-8000-${String(lista.length + 1).padStart(12, "0")}`, titulo: pregunta.slice(0, 60), actualizadaEn: new Date().toISOString(), mensajes: [] };
        lista.unshift(conv);
      }
      const seq = conv.mensajes.length + 2;
      conv.mensajes.push({ id: `m-${seq - 1}`, role: "user", text: pregunta, seq: seq - 1 });
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_SEMAFORO, status: "ok", blocks: [BLOQUE_SEMAFORO], sources: [FUENTE_SEMAFORO], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "plazos_semaforo" },
        { t: "paso", fase: "fin", herramienta: "plazos_semaforo" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_SEMAFORO, blocks: [BLOQUE_SEMAFORO], sources: [FUENTE_SEMAFORO], toolsUsed: ["plazos_semaforo"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${L}/chat-datos/conversaciones`, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${L}/chat-datos/conversaciones/:cid`, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${L}/chat-datos/conversaciones/:cid`,
    manejador: (p) => {
      const c = conversacionesMock(p).find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conversación no encontrada.");
      c.titulo = String(((p.cuerpo ?? {}) as { titulo?: string }).titulo ?? c.titulo);
      return { id: c.id, titulo: c.titulo };
    },
  },
  {
    metodo: "DELETE",
    patron: `${L}/chat-datos/conversaciones/:cid`,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
];

// L-26/L-28 -- cierre del expediente: doble aprobacion (tecnico-legal 1/2 y economica 2/2, dos personas distintas, step-up) y
// declaracion de la presentacion ante el portal. Replica las reglas del servidor (cierre.ts) para que lo que la pantalla muestre
// tras cada accion sea coherente; solo existe en la API simulada de e2e.
type EtapaCierre = "tecnica_legal" | "economica";
interface AprobacionCierre {
  readonly id: string;
  readonly approvedAt: string;
  readonly approvedByRole: string;
  readonly actorId: string;
}
type AprobacionesCierre = Record<EtapaCierre, AprobacionCierre | null>;
const CODIGO_TOTP_VALIDO = "123456";
const aprobacionesCierre = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<AprobacionesCierre>("lic.cierre.aprobaciones", () => ({ tecnica_legal: null, economica: null }));
const presentacionMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<{ registro: Record<string, unknown> | null; paquete: { generatedAt: string } | null }>("lic.cierre.presentacion", () => ({ registro: null, paquete: null }));

function estadoAprobaciones(a: AprobacionesCierre, actorId: string) {
  const vista = (stage: EtapaCierre) => ({ stage, approval: a[stage] ? { id: a[stage]!.id, approvedAt: a[stage]!.approvedAt, approvedByRole: a[stage]!.approvedByRole, byYou: a[stage]!.actorId === actorId } : null });
  const missing = (["tecnica_legal", "economica"] as const).filter((s) => a[s] === null);
  return { mode: "doble" as const, stages: [vista("tecnica_legal"), vista("economica")], complete: missing.length === 0, missing };
}

const rutasCierre: readonly Ruta[] = [
  { metodo: "GET", patron: "/auth/2fa/status", manejador: () => ({ available: true, enabled: true, pending: false, lockedUntil: null, backupCodesRemaining: 8 }) },
  {
    metodo: "POST",
    patron: "/auth/step-up",
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { scope?: string; code?: string };
      if (c.scope !== "expediente_approval") return fallo(400, "scope desconocido.");
      if (c.code !== CODIGO_TOTP_VALIDO) return fallo(422, "El código es incorrecto o ya se usó.");
      return { stepUpToken: `mock-step-up.${p.persona!.id}`, expiresInSeconds: 300 };
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid`, manejador: (p) => CONVOCATORIAS.find((c) => c.id === p.params["tid"]) ?? fallo(404, "Convocatoria no encontrada.") },
  { metodo: "GET", patron: `${L}/tenders/:tid/requirements`, manejador: () => ({ items: [] }) },
  { metodo: "GET", patron: `${L}/tenders/:tid/checklist`, manejador: () => ({ overallStatus: "verde", items: [{ id: "chk-1", dimension: "formato", result: "verde", notes: "Todos los archivos cumplen el formato del portal.", evidenceRef: null }] }) },
  { metodo: "GET", patron: `${L}/tenders/:tid/package/latest`, manejador: (p) => {
      const paquete = presentacionMock(p).paquete;
      return paquete ? { id: "exp-1", status: "ready", draftReasons: [], missing: [], generatedAt: paquete.generatedAt, notice: "La presentación y firma las realiza el usuario; el sistema no envía ofertas." } : fallo(404, "No se ha generado ningún paquete todavía para este expediente.");
    } },
  { metodo: "GET", patron: `${L}/tenders/:tid/expediente/approvals`, manejador: (p) => estadoAprobaciones(aprobacionesCierre(p), p.persona!.id) },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/expediente/approval`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const stage = ((p.cuerpo ?? {}) as { stage?: string }).stage;
      if (stage !== "tecnica_legal" && stage !== "economica") return fallo(400, "stage requerido: tecnica_legal | economica.");
      // Sin el token de step-up del propio usuario no se aprueba (igual que `requireStepUp` en el servidor).
      if (p.cabeceras["x-step-up-token"] !== `mock-step-up.${p.persona!.id}`) return fallo(403, "Esta acción requiere confirmar tu identidad con el código de tu app de autenticación.");
      const a = aprobacionesCierre(p);
      const otra: EtapaCierre = stage === "tecnica_legal" ? "economica" : "tecnica_legal";
      if (stage === "economica" && a.tecnica_legal === null) return fallo(409, "La aprobación económica (2/2) exige antes la aprobación técnico-legal (1/2) vigente para los insumos actuales del expediente.");
      if (a[otra]?.actorId === p.persona!.id) return fallo(403, "La aprobación técnico-legal y la económica deben darlas dos personas distintas: ya diste la otra aprobación de este expediente.");
      const nueva: AprobacionCierre = { id: `apr-${stage}`, approvedAt: "2026-10-01T16:00:00.000Z", approvedByRole: p.persona!.rol, actorId: p.persona!.id };
      a[stage] = nueva;
      return conStatus(201, { id: nueva.id, scope: "expediente", scopeRef: "expediente", status: "vigente", inputsHash: "hash-mock", decidedAt: nueva.approvedAt, stage });
    },
  },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/package/assemble`,
    manejador: (p) => {
      const a = aprobacionesCierre(p);
      if (a.tecnica_legal === null || a.economica === null) return fallo(409, "El expediente necesita la doble aprobación antes de ensamblar el paquete.");
      const generatedAt = "2026-10-01T18:00:00.000Z";
      presentacionMock(p).paquete = { generatedAt };
      return { id: "exp-1", status: "ready", draftReasons: [], missing: [], generatedAt, notice: "La presentación y firma las realiza el usuario; el sistema no envía ofertas." };
    },
  },
  { metodo: "GET", patron: `${L}/tenders/:tid/submission`, manejador: (p) => presentacionMock(p).registro },
  {
    metodo: "POST",
    patron: `${L}/tenders/:tid/submission/declare`,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { submittedAt?: string; notes?: string | null; acknowledgementContentBase64?: string | null };
      if (typeof p.cabeceras["idempotency-key"] !== "string" || p.cabeceras["idempotency-key"] === "") return fallo(400, "Falta el header Idempotency-Key.");
      if (!c.submittedAt || Number.isNaN(new Date(c.submittedAt).getTime())) return fallo(400, "submittedAt requerido (ISO 8601).");
      const estado = presentacionMock(p);
      // Idempotente: repetir la declaracion devuelve la ya registrada.
      estado.registro ??= { id: "sub-1", status: "submitted", submittedAt: c.submittedAt, acknowledgementStorageRef: c.acknowledgementContentBase64 ? "blob-1" : null, acknowledgementFileHash: c.acknowledgementContentBase64 ? "b".repeat(64) : null, notes: c.notes ?? null, createdAt: "2026-10-01T18:05:00.000Z" };
      return conStatus(201, estado.registro);
    },
  },
];

// L-25/L-29 -- gate final de la sala de guerra y bitacora de la convocatoria. Replican las reglas de salaGuerra.ts sobre el MISMO estado
// que el cierre (aprobaciones 2/2 y paquete), para que lo que muestre cada pantalla sea coherente tras cada accion; solo existe en la API
// simulada de e2e. "Ahora" del servidor simulado = 2026-10-01T18:00:00Z (igual que el resto de marcas de tiempo de este archivo).
const AHORA_MOCK = "2026-10-01T18:00:00.000Z";
const ETAPA_TEXTO: Record<EtapaCierre, string> = { tecnica_legal: "la aprobación técnico-legal (1/2)", economica: "la aprobación económica (2/2)" };

function gateMock(p: { estado: { obtener<T>(k: string, s: () => T): T }; params: Readonly<Record<string, string>> }) {
  const tender = CONVOCATORIAS.find((c) => c.id === p.params["tid"]);
  if (!tender) return fallo(404, "Convocatoria no encontrada.");
  const a = aprobacionesCierre(p);
  const registro = presentacionMock(p);
  const faltan = (["tecnica_legal", "economica"] as const).filter((s) => a[s] === null);
  const ms = Date.parse(tender.submissionDeadline) - Date.parse(AHORA_MOCK);
  const dias = Math.floor(ms / 86_400_000);
  const horas = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutos = Math.floor((ms % 3_600_000) / 60_000);
  const hayPaquete = registro.paquete !== null;
  const condiciones = [
    faltan.length === 0
      ? { id: "aprobaciones", label: "Doble aprobación", color: "verde", motivo: "Aprobado 2/2: técnico-legal y económica, por personas distintas.", enlace: null }
      : { id: "aprobaciones", label: "Doble aprobación", color: "rojo", motivo: `Falta ${faltan.map((f) => ETAPA_TEXTO[f]).join(" y ")}.`, enlace: "aprobaciones" },
    { id: "checklist", label: "Checklist de integridad", color: "verde", motivo: "Checklist de integridad en verde.", enlace: null },
    hayPaquete
      ? { id: "paquete", label: "Paquete de envío", color: "verde", motivo: "Paquete listo y vigente para el estado actual del expediente.", enlace: null }
      : { id: "paquete", label: "Paquete de envío", color: "rojo", motivo: "Todavía no hay un paquete de envío ensamblado.", enlace: "paquete" },
    hayPaquete
      ? { id: "zip_manifiesto", label: "ZIP contra manifiesto", color: "verde", motivo: "El ZIP coincide con el manifiesto (3 documento(s) verificados por sha256).", enlace: null }
      : { id: "zip_manifiesto", label: "ZIP contra manifiesto", color: "rojo", motivo: "No hay un ZIP guardado que verificar contra el manifiesto.", enlace: "paquete" },
    { id: "holgura", label: "Holgura al cierre", color: "verde", motivo: `Quedan ${dias} d ${horas} h ${minutos} min al cierre (2026-10-20 11:00 (America/Mexico_City)).`, enlace: null },
  ];
  const listo = !condiciones.some((c) => c.color === "rojo");
  return {
    now: AHORA_MOCK,
    tender: { id: tender.id, title: tender.title, submissionDeadline: tender.submissionDeadline },
    proposalId: "exp-1",
    presentado: registro.registro !== null,
    alerta: "no_aplica",
    gate: {
      listo,
      veredicto: listo ? "listo" : "no_listo",
      condiciones,
      motivos: condiciones.filter((c) => c.color !== "verde").map((c) => c.motivo),
      cuentaRegresiva: { estado: "abierto", msRestantes: ms, dias, horas, minutos, fechaCierreLocal: "2026-10-20", horaCierreLocal: "11:00", zonaHoraria: "America/Mexico_City" },
      holguraHoras: ms / 3_600_000,
      alerta24h: false,
    },
  };
}

const rutasSalaGuerra: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: `${L}/tenders/:tid/sala-guerra`,
    manejador: (p) => {
      const tender = CONVOCATORIAS.find((c) => c.id === p.params["tid"]);
      if (!tender) return fallo(404, "Convocatoria no encontrada.");
      return {
        available: true,
        now: AHORA_MOCK,
        viewerUserId: p.persona!.id,
        tender: { id: tender.id, title: tender.title, submissionDeadline: tender.submissionDeadline, status: tender.status },
        board: {
          items: [],
          summary: { requisitos: { total: 0, listos: 0, bloqueados: 0 }, tareas: { total: 0, listas: 0 }, riesgosAbiertos: 0, riesgosAltos: 0, sinResponsable: 0, avancePct: null, semaforoGeneral: "gris" },
          goNoGo: null,
          submissionDeadline: { at: tender.submissionDeadline, semaphore: { color: "verde", state: "en_tiempo", hoursRemaining: 455 } },
        },
        entries: [],
        goNoGoHistory: [],
        importableRequirements: [],
      };
    },
  },
  // La ficha de la convocatoria (donde vive la pestana Bitacora) carga estas tres lecturas junto con la convocatoria y el checklist.
  { metodo: "GET", patron: `${L}/tenders/:tid/matching`, manejador: (p) => ({ tenderId: p.params["tid"], score: 72, criteria: [], eligibility: { status: "elegible", criteria: [] } }) },
  { metodo: "GET", patron: `${L}/tenders/:tid/go-no-go`, manejador: () => ({ decisions: [] }) },
  { metodo: "GET", patron: `${L}/tenders/:tid/resolution`, manejador: () => ({ resolutions: [] }) },
  { metodo: "GET", patron: `${L}/tenders/:tid/sala-guerra/gate`, manejador: (p) => gateMock(p) },
  {
    metodo: "GET",
    patron: `${L}/tenders/:tid/bitacora`,
    manejador: (p) => {
      const a = aprobacionesCierre(p);
      const registro = presentacionMock(p).registro;
      const eventos: Array<{ id: string; fuente: string; accion: string; descripcion: string; at: string; actor: { esTuyo: boolean | null; rol: string | null } }> = [];
      for (const etapa of ["tecnica_legal", "economica"] as const) {
        const ap = a[etapa];
        if (ap) eventos.push({ id: `aprobacion:${ap.id}`, fuente: "aprobacion", accion: `aprobada_${etapa}`, descripcion: `Aprobación ${etapa === "tecnica_legal" ? "técnico-legal (1/2)" : "económica (2/2)"} del expediente.`, at: ap.approvedAt, actor: { esTuyo: ap.actorId === p.persona!.id, rol: ap.approvedByRole } });
      }
      if (registro) eventos.push({ id: `presentacion:${String(registro["id"])}`, fuente: "presentacion", accion: "declarada", descripcion: `Se declaró la presentación del expediente (fecha declarada ${String(registro["submittedAt"])}).`, at: String(registro["createdAt"]), actor: { esTuyo: null, rol: null } });
      const fuente = p.query.get("fuente");
      const filtrados = eventos.filter((e) => !fuente || e.fuente === fuente).sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (x.id < y.id ? 1 : -1));
      const limit = Number(p.query.get("limit") ?? 25);
      const offset = Number(p.query.get("offset") ?? 0);
      const items = filtrados.slice(offset, offset + limit);
      return { available: true, items, total: filtrados.length, nextOffset: offset + limit < filtrados.length ? offset + limit : null, limit, offset };
    },
  },
];

export const rutasLicitaciones: readonly Ruta[] = [
  ...rutasCopiloto,
  ...rutasCierre,
  ...rutasSalaGuerra,
  { metodo: "GET", patron: "/v1/licitaciones/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${L}/tenders`, manejador: () => ({ tenders: CONVOCATORIAS }) },
  { metodo: "GET", patron: `${L}/whatsapp/settings`, manejador: (p) => p.estado.obtener("lic.whatsapp", ajustesSemilla) },
  { metodo: "POST", patron: `${L}/whatsapp/opt-out`, manejador: (p) => {
      const a = p.estado.obtener("lic.whatsapp", ajustesSemilla);
      const cambio = a.contact !== null && a.contact.status !== "baja";
      if (a.contact) a.contact.status = "baja";
      return { ok: true, changed: cambio };
    } },
];

export const licitaciones = { orgSlug: ORG.slug, propertyId: PROP.id };
