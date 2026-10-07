// Fixtures de la bitacora de ESCRITURAS de licitaciones (L-P3-17). Forma = apps/web/src/verticals/licitaciones/lib/audit-trail-client.ts.
// Reglas espejo del servidor (bitacoraOrganizacion.ts): solo owner/admin leen (otros roles 403), filtros por entidad/persona/fecha/correlacion,
// paginacion por llave (`seq` descendente, `nextCursor`) y la traza de una convocatoria (cronologica, sus renglones + los que comparten su
// correlacion de origen). Solo existe en la API simulada de e2e. Va ANTES de `rutasLicitaciones` en indice.ts.
import { fallo } from "../respuestas.ts";
import { personaDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";

const L = "/licitaciones/:id";
const OWNER = personaDe("licitaciones", "owner");
const ADMIN = personaDe("licitaciones", "admin");
const STAFF = personaDe("licitaciones", "staff");
const PEOPLE: Record<string, string> = { [OWNER.id]: OWNER.fullName, [ADMIN.id]: ADMIN.fullName, [STAFF.id]: STAFF.fullName };

const ENTIDADES = ["documento_empresa", "tarifa", "capacidad", "experiencia", "firmante", "configuracion", "perfil_matching", "staff_invitacion", "staff_miembro", "convocatoria", "expediente", "paquete"];

interface Fila {
  id: string;
  seq: string;
  entity: string;
  entityId: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorId: string | null;
  correlationId: string | null;
  createdAt: string;
}

/** La traza de la convocatoria `tnd-1` (correlacion `ingesta-A1`) + historial de tarifas suficiente para exigir mas de una pagina (25). */
function semilla(): Fila[] {
  const filas: Omit<Fila, "id" | "seq">[] = [
    { entity: "convocatoria", entityId: "tnd-1", action: "convocatoria.ingerida", before: null, after: { source: "compranet", title: "Rehabilitacion de la avenida Reforma, tramo norte" }, actorId: null, correlationId: "ingesta-A1", createdAt: "2026-09-29T15:00:00.000Z" },
    { entity: "convocatoria", entityId: "tnd-1", action: "convocatoria.version_registrada", before: null, after: { version: 2 }, actorId: STAFF.id, correlationId: "ingesta-A1", createdAt: "2026-09-30T10:00:00.000Z" },
    { entity: "expediente", entityId: "tnd-1", action: "expediente.etapa_aprobada", before: null, after: { stage: "tecnica_legal", mode: "doble" }, actorId: ADMIN.id, correlationId: "ingesta-A1", createdAt: "2026-10-01T10:00:00.000Z" },
    { entity: "expediente", entityId: "tnd-1", action: "expediente.etapa_aprobada", before: null, after: { stage: "economica", mode: "doble" }, actorId: OWNER.id, correlationId: "ingesta-A1", createdAt: "2026-10-01T11:00:00.000Z" },
    { entity: "paquete", entityId: "tnd-1", action: "paquete.manifiesto_generado", before: null, after: { status: "ready" }, actorId: STAFF.id, correlationId: "ingesta-A1", createdAt: "2026-10-01T12:00:00.000Z" },
    { entity: "configuracion", entityId: null, action: "configuracion.editada", before: { timezone: "—" }, after: { timezone: "America/Cancun" }, actorId: OWNER.id, correlationId: "c-config-1", createdAt: "2026-10-02T09:00:00.000Z" },
  ];
  for (let i = 1; i <= 24; i += 1) {
    filas.push({ entity: "tarifa", entityId: "rate-1", action: "tarifa.editado", before: { unitPrice: `${400 + i}.00` }, after: { unitPrice: `${401 + i}.00` }, actorId: STAFF.id, correlationId: `c-tarifa-${i}`, createdAt: `2026-10-03T${String(i % 24).padStart(2, "0")}:00:00.000Z` });
  }
  return filas.map((f, i) => ({ ...f, id: `aud-${i + 1}`, seq: String(i + 1) }));
}

const filas = (p: Peticion): Fila[] => p.estado.obtener<Fila[]>("licitaciones.bitacora", semilla);
const nombres = (items: readonly Fila[]) => Object.fromEntries(items.flatMap((i) => (i.actorId && PEOPLE[i.actorId] ? [[i.actorId, PEOPLE[i.actorId]]] : [])));

const MIEMBROS = [OWNER, ADMIN, STAFF].map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, verticalRole: u.rol === "staff" ? "writer" : u.rol, propertyIds: null }));

export const rutasLicitacionesBitacora: readonly Ruta[] = [
  // La pantalla ofrece filtrar por persona con el mismo listado que usa Staff (GET .../admin/staff/miembros).
  { metodo: "GET", patron: "/v1/licitaciones/:id/admin/staff/miembros", roles: ["owner", "admin"], manejador: () => ({ miembros: MIEMBROS }) },
  {
    metodo: "GET",
    patron: `${L}/audit-trail`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const q = p.query;
      const limit = Number(q.get("limit") ?? 25);
      const cursor = q.get("cursor");
      let items = filas(p).filter(
        (f) =>
          (!q.get("entity") || f.entity === q.get("entity")) &&
          (!q.get("actorId") || f.actorId === q.get("actorId")) &&
          (!q.get("correlationId") || f.correlationId === q.get("correlationId")) &&
          (!q.get("desde") || f.createdAt >= q.get("desde")!) &&
          (!q.get("hasta") || f.createdAt <= q.get("hasta")!) &&
          (!cursor || Number(f.seq) < Number(cursor)),
      );
      items = items.sort((a, b) => Number(b.seq) - Number(a.seq));
      const pagina = items.slice(0, limit);
      return { items: pagina, nextCursor: items.length > limit ? pagina[pagina.length - 1]!.seq : null, available: true, entities: ENTIDADES, people: nombres(pagina) };
    },
  },
  {
    metodo: "GET",
    patron: `${L}/audit-trail/tenders/:tid/trace`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const tid = p.params["tid"] ?? "";
      const todas = filas(p);
      const origen = new Set(todas.filter((f) => f.entity === "convocatoria" && f.entityId === tid && f.correlationId).map((f) => f.correlationId));
      if (origen.size === 0 && !todas.some((f) => f.entityId === tid)) return fallo(404, "Convocatoria no encontrada.");
      const items = todas.filter((f) => f.entityId === tid || (f.correlationId !== null && origen.has(f.correlationId))).sort((a, b) => Number(a.seq) - Number(b.seq));
      return { items, nextCursor: null, available: true, people: nombres(items) };
    },
  },
];
