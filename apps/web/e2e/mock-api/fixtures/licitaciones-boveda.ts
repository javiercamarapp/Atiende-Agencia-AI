// Bóveda de bases, matriz de requisitos editable, conflictos persistidos y revisión del expediente (paridad3, L-P3-05/06/07).
// Replica las reglas del servidor (apps/api/.../boveda.ts, revision.ts) lo justo para que lo que la pantalla muestre tras cada
// accion sea coherente: validacion por contenido (un ZIP se rechaza), upsert estable (la re-extraccion conserva lo editado a
// mano), conflictos que se abren al haber dos plazos y se resuelven con notas, edicion de secciones que invalida la
// aprobacion (AE-02) y autoria que impide aprobar (AE-11). Solo existe en la API simulada de e2e.
import { conStatus, fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";

const ORG = orgDe("licitaciones");
const PROP = propiedadDe("licitaciones");
const L = "/licitaciones/:id/tenders/:tid";

interface DocMock {
  id: string;
  tenderId: string;
  documentType: string;
  title: string | null;
  filename: string | null;
  mimeType: string | null;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  extractionStatus: "extracted" | "requires_ocr" | "failed";
  extractionDetail: string | null;
  lineageId: string;
  version: number;
  latest: boolean;
  createdAt: string;
  pages: { page: number; text: string }[] | null;
}

interface ItemMock {
  id: string;
  documentId: string;
  lineageId: string;
  text: string;
  requirementKind: string;
  obligatoriedad: string;
  topicKey: string | null;
  requiredEvidence: string[];
  extractedBy: "rule";
  page: number;
  clause: string | null;
  responsibleRole: string;
  deadline: string | null;
  status: string;
  confidence: number | null;
  assignedTo: string | null;
  disqualifying: boolean;
  manuallyEditedAt: string | null;
  retiredAt: string | null;
  retiredInVersion: number | null;
}

interface ConflictMock {
  id: string;
  key: string;
  kind: "deadline_mismatch";
  topicKey: string;
  description: string;
  itemIds: string[];
  status: "abierto" | "resuelto";
  resolutionNotes: string | null;
  resolvedAt: string | null;
}

interface SectionMock {
  sectionKey: string;
  label: string;
  content: string;
  version: number;
  authors: Set<string>;
  approvedBy: string | null;
}

interface CommentMock {
  id: string;
  scope: "seccion" | "expediente";
  scopeRef: string;
  kind: "comentario" | "solicitud_revision";
  body: string;
  authorRole: string;
  authorId: string;
  createdAt: string;
}

interface BovedaMock {
  n: number;
  docs: DocMock[];
  items: ItemMock[];
  conflicts: ConflictMock[];
  sections: SectionMock[];
  comments: CommentMock[];
}

const semilla = (): BovedaMock => ({
  n: 0,
  docs: [],
  items: [],
  conflicts: [],
  sections: [
    { sectionKey: "technical:legal", label: "Cumplimiento legal", content: "Se acompaña acta constitutiva vigente.", version: 1, authors: new Set(), approvedBy: null },
    { sectionKey: "technical:tecnica", label: "Propuesta técnica", content: "Plan de trabajo y metodología constructiva.", version: 1, authors: new Set(), approvedBy: null },
  ],
  comments: [],
});

const estadoDe = (p: Peticion): BovedaMock => p.estado.obtener<BovedaMock>("lic.boveda", semilla);
const ahora = (s: BovedaMock): string => new Date(Date.UTC(2026, 9, 3, 12, 0, s.n)).toISOString();

const MESES: Record<string, string> = { octubre: "10", noviembre: "11", diciembre: "12" };

function hash(texto: string): string {
  let h = 0;
  for (const ch of texto) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Extrae requisitos de un texto: una oracion con "deberá"/"será a más tardar" es un requisito; el plazo se lee de "DD de mes del AAAA". */
function extraer(doc: DocMock): Omit<ItemMock, "id">[] {
  const salida: Omit<ItemMock, "id">[] = [];
  for (const pagina of doc.pages ?? []) {
    for (const oracion of pagina.text.split(/(?<=\.)\s+/)) {
      const texto = oracion.trim();
      if (!/deber[aá]|ser[aá] a m[aá]s tardar/i.test(texto)) continue;
      const fecha = /(\d{1,2}) de (octubre|noviembre|diciembre) del (\d{4})/i.exec(texto);
      const esPlazo = /entrega de proposiciones/i.test(texto);
      salida.push({
        documentId: doc.id,
        lineageId: doc.lineageId,
        text: texto,
        requirementKind: /acta|legal/i.test(texto) ? "legal" : "administrativo",
        obligatoriedad: "obligatorio",
        topicKey: esPlazo ? "plazo_entrega_proposiciones" : /acta constitutiva/i.test(texto) ? "acta_constitutiva" : null,
        requiredEvidence: [],
        extractedBy: "rule",
        page: pagina.page,
        clause: null,
        responsibleRole: /acta|legal/i.test(texto) ? "legal" : "licitador",
        deadline: fecha ? `${fecha[3]}-${MESES[fecha[2]!.toLowerCase()]}-${fecha[1]!.padStart(2, "0")}T18:00:00-06:00` : null,
        status: "pendiente",
        confidence: null,
        assignedTo: null,
        disqualifying: false,
        manuallyEditedAt: null,
        retiredAt: null,
        retiredInVersion: null,
      });
    }
  }
  return salida;
}

/** Re-extraccion estable: misma clave (linaje + texto) = misma fila (conserva lo editado a mano); lo que falta se retira. */
function reextraer(s: BovedaMock, docs: readonly DocMock[]): { created: number; updated: number; retired: number } {
  let created = 0;
  let updated = 0;
  const vistos = new Set<string>();
  for (const doc of docs) {
    for (const nuevo of extraer(doc)) {
      const clave = `${doc.lineageId}|${hash(nuevo.text.toLowerCase())}`;
      const previo = s.items.find((i) => !i.retiredAt && `${i.lineageId}|${hash(i.text.toLowerCase())}` === clave);
      if (previo) {
        vistos.add(previo.id);
        previo.documentId = doc.id;
        updated += 1;
      } else {
        s.n += 1;
        const fila: ItemMock = { id: `req-${hash(clave)}`, ...nuevo };
        s.items.push(fila);
        vistos.add(fila.id);
        created += 1;
      }
    }
  }
  const lineas = new Set(docs.map((d) => d.lineageId));
  let retired = 0;
  for (const i of s.items) {
    if (!i.retiredAt && !vistos.has(i.id) && lineas.has(i.lineageId)) {
      i.retiredAt = ahora(s);
      i.retiredInVersion = 2;
      retired += 1;
    }
  }
  sincronizarConflictos(s);
  return { created, updated, retired };
}

/** Dos plazos distintos para el mismo tema = conflicto abierto (uno resuelto con la misma huella no se reabre; uno que ya no se detecta se cierra solo). */
function sincronizarConflictos(s: BovedaMock): void {
  const activos = s.items.filter((i) => !i.retiredAt && i.topicKey === "plazo_entrega_proposiciones" && i.deadline);
  const plazos = new Set(activos.map((i) => i.deadline));
  const detectados: { key: string; ids: string[] }[] = [];
  if (plazos.size > 1) detectados.push({ key: activos.map((i) => i.id).sort().join(","), ids: activos.map((i) => i.id) });
  for (const d of detectados) {
    const existente = s.conflicts.find((c) => c.key === d.key);
    if (existente) continue;
    s.n += 1;
    s.conflicts.push({
      id: `conf-${s.n}`,
      key: d.key,
      kind: "deadline_mismatch",
      topicKey: "plazo_entrega_proposiciones",
      description: `Se encontraron ${plazos.size} fechas límite distintas para "plazo_entrega_proposiciones" en documentos distintos. Requiere una decisión humana; ninguna se aplica automáticamente.`,
      itemIds: d.ids,
      status: "abierto",
      resolutionNotes: null,
      resolvedAt: null,
    });
  }
  for (const c of s.conflicts) {
    if (c.status === "abierto" && !detectados.some((d) => d.key === c.key)) {
      c.status = "resuelto";
      c.resolutionNotes = "Cierre automático: la última extracción ya no detecta este conflicto.";
      c.resolvedAt = ahora(s);
    }
  }
  const bloqueados = new Set(s.conflicts.filter((c) => c.status === "abierto").flatMap((c) => c.itemIds));
  for (const i of s.items) {
    if (i.retiredAt || i.manuallyEditedAt) continue;
    if (bloqueados.has(i.id) && i.deadline) i.status = "bloqueado";
    else if (i.status === "bloqueado") i.status = "pendiente";
  }
}

function docPublico(d: DocMock, todos: readonly DocMock[]): Omit<DocMock, "pages"> {
  const { pages: _pages, ...resto } = d;
  return { ...resto, latest: d.version === Math.max(...todos.filter((x) => x.lineageId === d.lineageId).map((x) => x.version)) };
}

function seccionPublica(sec: SectionMock, personaId: string) {
  return { sectionKey: sec.sectionKey, label: sec.label, content: sec.content, version: sec.version, authorCount: sec.authors.size, authoredByViewer: sec.authors.has(personaId), approved: sec.approvedBy !== null, expedienteApproved: false };
}

export const rutasBovedaRevision: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/documents`, manejador: (p) => { const s = estadoDe(p); return { disponible: true, documents: s.docs.map((d) => docPublico(d, s.docs)).reverse(), tipos: [] }; } },
  {
    metodo: "POST",
    patron: `${L}/documents`,
    manejador: (p) => {
      const s = estadoDe(p);
      if (typeof p.cabeceras["idempotency-key"] !== "string") return fallo(400, "Falta el header Idempotency-Key, obligatorio para esta operación de dinero.");
      const c = (p.cuerpo ?? {}) as { documentType?: string; title?: string | null; filename?: string | null; mimeType?: string | null; contentBase64?: string; replacesDocumentId?: string | null };
      const bytes = Buffer.from(String(c.contentBase64 ?? ""), "base64");
      if (bytes.length === 0) return fallo(400, "contentBase64: se esperaba el archivo en base64.");
      // AE-03/AE-05: se rechaza por el CONTENIDO (un ZIP/DOCX empieza con "PK"), nunca por el nombre.
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) return fallo(422, "Los archivos comprimidos (ZIP, DOCX, XLSX) no se aceptan: suba el PDF o un texto plano. (zip_rechazado)");
      const texto = bytes.toString("utf8");
      s.n += 1;
      let lineageId = `lin-${s.n}`;
      let version = 1;
      if (c.replacesDocumentId) {
        const previo = s.docs.find((d) => d.id === c.replacesDocumentId);
        if (!previo) return fallo(404, "El documento que se reemplaza no existe en esta convocatoria.");
        lineageId = previo.lineageId;
        version = Math.max(...s.docs.filter((d) => d.lineageId === lineageId).map((d) => d.version)) + 1;
      }
      const sinTexto = texto.trim().length === 0;
      const doc: DocMock = {
        id: `doc-${s.n}`,
        tenderId: p.params["tid"] ?? "",
        documentType: c.documentType ?? "bases",
        title: c.title ?? null,
        filename: c.filename ?? null,
        mimeType: c.mimeType ?? null,
        sha256: hash(texto).padEnd(64, "0"),
        sizeBytes: bytes.length,
        pageCount: 1,
        extractionStatus: sinTexto ? "requires_ocr" : "extracted",
        extractionDetail: sinTexto ? "Documento sin capa de texto extraíble: requiere OCR, no soportado." : null,
        lineageId,
        version,
        latest: true,
        createdAt: ahora(s),
        pages: sinTexto ? null : [{ page: 1, text: texto }],
      };
      s.docs.push(doc);
      return conStatus(201, { document: docPublico(doc, s.docs) });
    },
  },
  {
    metodo: "GET",
    patron: `${L}/documents/:did`,
    manejador: (p) => {
      const s = estadoDe(p);
      const d = s.docs.find((x) => x.id === p.params["did"]);
      if (!d) return fallo(404, "Documento no encontrado.");
      const n = Number(p.query.get("page"));
      return { document: docPublico(d, s.docs), page: d.pages?.find((x) => x.page === n) ?? null };
    },
  },
  { metodo: "GET", patron: `${L}/requirement-assignees`, manejador: () => ({ assignees: [{ userId: "licitaciones-admin", nombre: "Admin licitaciones", rol: "admin" }, { userId: "licitaciones-owner", nombre: "Owner licitaciones", rol: "owner" }] }) },
  {
    metodo: "POST",
    patron: `${L}/requirements/extract`,
    manejador: (p) => {
      const s = estadoDe(p);
      if (typeof p.cabeceras["idempotency-key"] !== "string") return fallo(400, "Falta el header Idempotency-Key, obligatorio para esta operación de dinero.");
      const c = (p.cuerpo ?? {}) as { documentIds?: string[] };
      const docs = (c.documentIds ?? []).map((id) => s.docs.find((d) => d.id === id)).filter((d): d is DocMock => d !== undefined);
      if (docs.length === 0) return fallo(404, "Un documento indicado no existe en esta convocatoria.");
      const extraibles = docs.filter((d) => d.extractionStatus === "extracted");
      if (extraibles.length === 0) return fallo(422, "Ningún documento produjo texto extraíble.");
      const matrix = reextraer(s, extraibles);
      return {
        items: [],
        conflicts: s.conflicts.map(({ key: _k, ...resto }) => resto),
        skippedDocuments: docs.filter((d) => d.extractionStatus !== "extracted").map((d) => ({ documentId: d.id, documentLabel: d.title ?? d.filename ?? "Documento", status: d.extractionStatus, detail: d.extractionDetail })),
        matrix: { mode: "estable", ...matrix, unchanged: 0 },
      };
    },
  },
  {
    metodo: "PATCH",
    patron: `${L}/requirements/:rid`,
    manejador: (p) => {
      const s = estadoDe(p);
      const i = s.items.find((x) => x.id === p.params["rid"] && !x.retiredAt);
      if (!i) return fallo(404, "Requisito no encontrado.");
      const c = (p.cuerpo ?? {}) as { responsibleRole?: string; status?: string; assignedTo?: string | null; disqualifying?: boolean };
      if (c.status === "bloqueado") return fallo(400, 'status: "bloqueado" lo pone el sistema por un conflicto abierto.');
      if (c.responsibleRole !== undefined) i.responsibleRole = c.responsibleRole;
      if (c.status !== undefined) i.status = c.status;
      if (c.assignedTo !== undefined) i.assignedTo = c.assignedTo;
      if (c.disqualifying !== undefined) i.disqualifying = c.disqualifying;
      i.manuallyEditedAt = ahora(s);
      const { lineageId: _l, ...resto } = i;
      return { item: resto };
    },
  },
  { metodo: "GET", patron: `${L}/requirements/conflicts`, manejador: (p) => ({ disponible: true, conflicts: estadoDe(p).conflicts.map(({ key: _k, ...resto }) => resto) }) },
  {
    metodo: "POST",
    patron: `${L}/requirements/conflicts/:cid/resolve`,
    manejador: (p) => {
      const s = estadoDe(p);
      const c = s.conflicts.find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conflicto no encontrado.");
      if (c.status === "resuelto") return fallo(409, "Este conflicto ya estaba resuelto.");
      const notas = String(((p.cuerpo ?? {}) as { notes?: string }).notes ?? "").trim();
      if (notas.length === 0) return fallo(400, "notes: las notas de resolución son obligatorias.");
      c.status = "resuelto";
      c.resolutionNotes = notas;
      c.resolvedAt = ahora(s);
      sincronizarConflictos(s);
      const { key: _k, ...resto } = c;
      return { conflict: resto };
    },
  },
  { metodo: "GET", patron: `${L}/proposal/sections`, manejador: (p) => ({ sections: estadoDe(p).sections.map((x) => seccionPublica(x, p.persona!.id)) }) },
  {
    metodo: "PATCH",
    patron: `${L}/proposal/sections/:key`,
    manejador: (p) => {
      const s = estadoDe(p);
      const sec = s.sections.find((x) => x.sectionKey === p.params["key"]);
      if (!sec) return fallo(404, "Sección no encontrada.");
      const contenido = String(((p.cuerpo ?? {}) as { content?: string }).content ?? "");
      if (contenido.trim().length === 0) return fallo(400, "content: el contenido de la sección no puede quedar vacío.");
      // AE-02: el mismo texto no cambia nada ni invalida la aprobacion.
      if (contenido === sec.content) return { section: seccionPublica(sec, p.persona!.id), changed: false, invalidatedApprovals: 0 };
      sec.content = contenido;
      sec.version += 1;
      sec.authors.add(p.persona!.id); // AE-11: queda como autor.
      const invalidadas = sec.approvedBy !== null ? 1 : 0;
      sec.approvedBy = null;
      return { section: seccionPublica(sec, p.persona!.id), changed: true, invalidatedApprovals: invalidadas };
    },
  },
  {
    metodo: "POST",
    patron: `${L}/proposal/sections/:key/approval`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const s = estadoDe(p);
      const sec = s.sections.find((x) => x.sectionKey === p.params["key"]);
      if (!sec) return fallo(404, "Sección no encontrada.");
      if (sec.authors.has(p.persona!.id)) return fallo(403, "El actor no puede aprobar esta sección: consta como autor de su contenido (AE-11).");
      sec.approvedBy = p.persona!.id;
      return conStatus(201, { id: `apr-${sec.sectionKey}`, scope: "seccion", scopeRef: `seccion:${sec.sectionKey}`, status: "vigente", inputsHash: "hash-mock", decidedAt: "2026-10-03T12:00:00.000Z" });
    },
  },
  {
    metodo: "GET",
    patron: `${L}/proposal/comments`,
    manejador: (p) => ({
      disponible: true,
      comments: estadoDe(p).comments.map(({ authorId, ...resto }) => ({ ...resto, esTuyo: authorId === p.persona!.id, authorName: authorId === "licitaciones-admin" ? "Admin licitaciones" : "Owner licitaciones" })),
    }),
  },
  {
    metodo: "POST",
    patron: `${L}/proposal/comments`,
    manejador: (p) => {
      const s = estadoDe(p);
      const c = (p.cuerpo ?? {}) as { scope?: "seccion" | "expediente"; sectionKey?: string; body?: string };
      if (String(c.body ?? "").trim().length === 0) return fallo(400, "body: escribe el comentario.");
      s.n += 1;
      const comentario: CommentMock = { id: `com-${s.n}`, scope: c.scope === "seccion" ? "seccion" : "expediente", scopeRef: c.scope === "seccion" ? `seccion:${c.sectionKey}` : "expediente", kind: "comentario", body: String(c.body).trim(), authorRole: p.persona!.rol, authorId: p.persona!.id, createdAt: ahora(s) };
      s.comments.push(comentario);
      const { authorId, ...resto } = comentario;
      return conStatus(201, { comment: { ...resto, esTuyo: authorId === p.persona!.id } });
    },
  },
  {
    metodo: "POST",
    patron: `${L}/proposal/request-review`,
    manejador: (p) => {
      const s = estadoDe(p);
      const c = (p.cuerpo ?? {}) as { scope?: "seccion" | "expediente"; sectionKey?: string; note?: string };
      s.n += 1;
      const cuerpo = String(c.note ?? "").trim() || (c.scope === "seccion" ? "Se solicitó la revisión de una sección." : "Se solicitó la revisión del expediente.");
      const comentario: CommentMock = { id: `rev-${s.n}`, scope: c.scope === "seccion" ? "seccion" : "expediente", scopeRef: c.scope === "seccion" ? `seccion:${c.sectionKey}` : "expediente", kind: "solicitud_revision", body: cuerpo, authorRole: p.persona!.rol, authorId: p.persona!.id, createdAt: ahora(s) };
      s.comments.push(comentario);
      p.estado.guardar("lic.boveda.ultimaSolicitud", { por: p.persona!.id });
      const { authorId, ...resto } = comentario;
      return conStatus(201, { comment: { ...resto, esTuyo: authorId === p.persona!.id } });
    },
  },
];

/**
 * Matriz de la boveda para `GET .../requirements`: `null` mientras nadie subio nada (la fixture simple de licitaciones.ts atiende,
 * con sus requisitos por reglas y por IA); con documentos, la matriz estable (con asignado, causa de desechamiento y retirados).
 */
export function matrizBoveda(p: Peticion): { migrated: true; items: unknown[] } | null {
  const s = estadoDe(p);
  if (s.docs.length === 0) return null;
  const conRetirados = p.query.get("includeRetired") === "1";
  return { migrated: true, items: s.items.filter((i) => conRetirados || !i.retiredAt).map(({ lineageId: _l, ...resto }) => resto) };
}

export const bovedaMock = { orgId: ORG.id, propertyId: PROP.id };
