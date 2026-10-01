// Rutas transversales a todas las verticales (campana de notificaciones, "Chatea con tus datos").
import type { Ruta } from "../tipos.ts";

interface Notificacion {
  id: string;
  vertical: string | null;
  titulo: string;
  cuerpo: string | null;
  createdAt: string;
  readAt: string | null;
}

const NOTIFICACIONES: Notificacion[] = [
  { id: "ntf-1", vertical: null, titulo: "Bienvenido al panel", cuerpo: "Este es un entorno de pruebas con datos ficticios.", createdAt: "2026-09-30T15:00:00.000Z", readAt: null },
];

function noLeidas(lista: Notificacion[]): number {
  return lista.filter((n) => n.readAt === null).length;
}

/** "Chatea con tus datos" no esta disponible en el mock: la SPA debe mostrarlo de forma honesta (`available: false`). */
const ESTADO_CHAT = () => ({ available: false });

export const rutasComunes: readonly Ruta[] = [
  { metodo: "GET", patron: "/notifications", manejador: (p) => {
      const lista = p.estado.obtener("notificaciones", () => structuredClone(NOTIFICACIONES));
      return { notifications: lista, unreadCount: noLeidas(lista) };
    } },
  { metodo: "POST", patron: "/notifications/read-all", manejador: (p) => {
      const lista = p.estado.obtener("notificaciones", () => structuredClone(NOTIFICACIONES));
      for (const n of lista) n.readAt = n.readAt ?? "2026-09-30T16:00:00.000Z";
      return { ok: true };
    } },
  { metodo: "POST", patron: "/notifications/:id/read", manejador: (p) => {
      const lista = p.estado.obtener("notificaciones", () => structuredClone(NOTIFICACIONES));
      const n = lista.find((x) => x.id === p.params.id);
      if (n) n.readAt = n.readAt ?? "2026-09-30T16:00:00.000Z";
      return { ok: true };
    } },
  { metodo: "GET", patron: "/v1/restaurantes/:id/admin/chat-datos/estado", manejador: ESTADO_CHAT },
  { metodo: "GET", patron: "/hoteles/:id/chat-datos/estado", manejador: ESTADO_CHAT },
  { metodo: "GET", patron: "/rentas/:id/chat-datos/estado", manejador: ESTADO_CHAT },
  { metodo: "GET", patron: "/despachos/:id/chat-datos/estado", manejador: ESTADO_CHAT },
  { metodo: "GET", patron: "/licitaciones/:id/chat-datos/estado", manejador: ESTADO_CHAT },
  { metodo: "GET", patron: "/citas/:id/chat-datos/estado", manejador: ESTADO_CHAT },
];
