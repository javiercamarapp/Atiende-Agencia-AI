// Fixtures de hoteles (Hotel Casa Azul). Forma = apps/web/src/verticals/hoteles/lib/*-client.ts.
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("hoteles");
const ORG = orgDe("hoteles");
const H = "/hoteles/:id";

function ticketsSemilla() {
  const ahora = Date.now();
  return [
    { id: "tkt-1", habitacion: "204", resenaId: null, departamento: "housekeeping", prioridad: "media", estado: "abierto", canal: "recepcion", mensaje: "Faltan toallas en la habitacion 204", slaMinutos: 60, slaVenceEn: new Date(ahora + 40 * 60_000).toISOString(), estadoSla: "en_tiempo", minutosParaVencer: 40, asignadoA: null, escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 20 * 60_000).toISOString() },
    { id: "tkt-2", habitacion: "112", resenaId: null, departamento: "maintenance", prioridad: "alta", estado: "en_progreso", canal: "huesped", mensaje: "El aire acondicionado de la 112 no enfria", slaMinutos: 120, slaVenceEn: new Date(ahora + 15 * 60_000).toISOString(), estadoSla: "por_vencer", minutosParaVencer: 15, asignadoA: "Equipo de mantenimiento", escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 105 * 60_000).toISOString() },
  ];
}

type Ticket = ReturnType<typeof ticketsSemilla>[number];

const ESTADO_POR_ACCION: Record<string, string> = { iniciar: "en_progreso", cerrar: "cerrado", cancelar: "cancelado", escalar: "escalado" };

export const rutasHoteles: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/hoteles/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
  // Rutas especificas antes que `:tid` (el router toma la primera que coincide).
  { metodo: "GET", patron: `${H}/tickets/resenas-pendientes`, manejador: () => ({ disponible: true, resenas: [] }) },
  { metodo: "GET", patron: `${H}/tickets/sla`, manejador: () => ({ disponible: true, efectiva: [{ departamento: "housekeeping", prioridad: "media", minutos: 60, configurada: false }] }) },
  { metodo: "GET", patron: `${H}/tickets`, manejador: (p) => {
      const todos = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla);
      const activos = p.query.get("activos") === "1";
      return { disponible: true, ahora: new Date().toISOString(), tickets: activos ? todos.filter((t) => t.estado !== "cerrado" && t.estado !== "cancelado") : todos };
    } },
  { metodo: "POST", patron: `${H}/tickets/:tid/:accion`, manejador: (p) => {
      const t = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla).find((x) => x.id === p.params.tid);
      const estado = ESTADO_POR_ACCION[p.params.accion ?? ""];
      if (!t || !estado) return fallo(404, "Ticket o accion desconocidos");
      t.estado = estado;
      return t;
    } },
];

export const hoteles = { orgSlug: ORG.slug, propertyId: PROP.id };
