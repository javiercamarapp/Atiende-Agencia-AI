// Rutas transversales a todas las verticales (campana de notificaciones, "Chatea con tus datos").
import type { EstadoEscenario, Ruta } from "../tipos.ts";
import { fallo } from "../respuestas.ts";

export interface Notificacion {
  id: string;
  vertical: string | null;
  titulo: string;
  cuerpo: string | null;
  entidadTipo: string | null;
  entidadId: string | null;
  createdAt: string;
  readAt: string | null;
  organizationId: string | null;
  tipo: string | null;
  categoria: string | null;
  severidad: "info" | "atencion" | "critica";
  enlace: string | null;
}

const CLAVE = "notificaciones";
const MARCA_LECTURA = "2026-09-30T16:00:00.000Z";

/** Pantalla real de cada consola a la que lleva una notificacion (rutas del catalogo `docs/NOTIFICACIONES.md`). */
const DESTINOS: Readonly<Record<string, string>> = {
  restaurantes: "pedidos",
  hoteles: "tickets",
  rentas: "calendario",
  despachos: "cola-cobranza",
  licitaciones: "seguimiento",
  citas: "agenda",
};

function destino(persona: { vertical: string | null; orgSlug: string } | null): string | null {
  if (!persona) return null;
  return persona.vertical ? `/${persona.vertical}/${persona.orgSlug}/${DESTINOS[persona.vertical] ?? ""}` : "/superadmin/salud";
}

/** Semilla honesta: textos sin PII, severidades y categorias del catalogo, una ya leida. */
function semilla(persona: { vertical: string | null; orgSlug: string } | null): Notificacion[] {
  const enlace = destino(persona);
  const base = { vertical: persona?.vertical ?? null, entidadTipo: null, entidadId: null, organizationId: null };
  return [
    { ...base, id: "ntf-1", titulo: "Hay algo nuevo por atender", cuerpo: "Revisa la pantalla de origen para resolverlo.", createdAt: "2026-09-30T15:00:00.000Z", readAt: null, tipo: "e2e.operacion", categoria: "operacion", severidad: "atencion", enlace },
    { ...base, id: "ntf-2", titulo: "Un proveedor está registrando errores", cuerpo: null, createdAt: "2026-09-30T14:00:00.000Z", readAt: null, tipo: "e2e.salud", categoria: "salud", severidad: "critica", enlace },
    { ...base, id: "ntf-3", titulo: "Cierre del día completado", cuerpo: null, createdAt: "2026-09-29T20:00:00.000Z", readAt: MARCA_LECTURA, tipo: "e2e.cierres", categoria: "cierres", severidad: "info", enlace: null },
  ];
}

function lista(estado: EstadoEscenario, persona: { vertical: string | null; orgSlug: string } | null): Notificacion[] {
  return estado.obtener(CLAVE, () => semilla(persona));
}

function noLeidas(l: Notificacion[]): number {
  return l.filter((n) => n.readAt === null).length;
}

/** Control del mock (no de la API real): una notificacion nueva sin leer, como si un evento la hubiera emitido. */
export function agregarNotificacion(estado: EstadoEscenario, nueva: Partial<Notificacion> & { titulo: string }): Notificacion {
  const l = lista(estado, null);
  const fila: Notificacion = {
    id: `ntf-nueva-${l.length + 1}`,
    vertical: null,
    cuerpo: null,
    entidadTipo: null,
    entidadId: null,
    organizationId: null,
    tipo: "e2e.nueva",
    categoria: "operacion",
    severidad: "atencion",
    enlace: null,
    createdAt: new Date().toISOString(),
    readAt: null,
    ...nueva,
  };
  l.push(fila);
  return fila;
}

/** "Chatea con tus datos" no esta disponible en el mock de despachos/licitaciones/citas: la SPA debe mostrarlo de forma honesta (`available: false`).
 *  Restaurantes (CHAT-08), hoteles (CHAT-09), rentas (CHAT-10), licitaciones (CHAT-12) y citas (CHAT-13) lo sirven activo desde sus fixtures. */
const ESTADO_CHAT = () => ({ available: false });

export const rutasComunes: readonly Ruta[] = [
  { metodo: "GET", patron: "/notifications/unread-count", manejador: (p) => ({ unreadCount: noLeidas(lista(p.estado, p.persona)) }) },
  { metodo: "GET", patron: "/notifications", manejador: (p) => {
      const todas = lista(p.estado, p.persona);
      let filas = [...todas].sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
      if (p.query.get("unread") === "1") filas = filas.filter((n) => n.readAt === null);
      const categoria = p.query.get("categoria");
      if (categoria) filas = filas.filter((n) => n.categoria === categoria);
      const antes = p.query.get("before");
      if (antes) filas = filas.filter((n) => n.createdAt < antes);
      const limite = Math.min(Math.max(Number(p.query.get("limit") ?? 50) || 50, 1), 100);
      return { notifications: filas.slice(0, limite), unreadCount: noLeidas(todas) };
    } },
  { metodo: "POST", patron: "/notifications/read-all", manejador: (p) => {
      const todas = lista(p.estado, p.persona);
      const marcadas = noLeidas(todas);
      for (const n of todas) n.readAt = n.readAt ?? MARCA_LECTURA;
      return { ok: true, markedCount: marcadas, unreadCount: 0 };
    } },
  { metodo: "POST", patron: "/notifications/:id/read", manejador: (p) => {
      const todas = lista(p.estado, p.persona);
      const n = todas.find((x) => x.id === p.params.id);
      if (!n) return fallo(404, "La notificación no existe.");
      n.readAt = n.readAt ?? MARCA_LECTURA;
      return { ok: true, unreadCount: noLeidas(todas) };
    } },
  { metodo: "GET", patron: "/despachos/:id/chat-datos/estado", manejador: ESTADO_CHAT },
];
