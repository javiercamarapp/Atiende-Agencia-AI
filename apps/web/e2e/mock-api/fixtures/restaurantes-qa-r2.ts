// Fixtures de la API SIMULADA para la ronda 2 de QA de botones de restaurantes (qa-r2-botones-*): las escrituras que el recorrido base no
// cubria (puentes, ficha del cliente 360, historial de un pedido). La forma copia apps/web/src/verticals/restaurantes/lib/{modelo-pm,customers,
// autopiloto}-client.ts. Solo existe en la API simulada de e2e: jamas se usa contra el backend ni la base reales.
import { fallo } from "../respuestas.ts";
import type { Ruta } from "../tipos.ts";

const B = "/v1/restaurantes/:id/admin";

interface PuenteMock {
  id: string;
  branchId: string;
  fechaDesde: string;
  fechaHasta: string;
  horario: Array<{ dias: number[]; abre: string; cierra: string }>;
  motivo: string | null;
}

type Estado = { estado: { obtener<T>(k: string, s: () => T): T } };
const puentes = (p: Estado): PuenteMock[] => p.estado.obtener<PuenteMock[]>("rest.puentes", () => []);

export const rutasRestaurantesQaR2: readonly Ruta[] = [
  // ---------- Puentes (excepciones de horario por fecha) ----------
  {
    metodo: "POST",
    patron: `${B}/config/puentes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { branchIds?: string[]; fechaDesde?: string; fechaHasta?: string; turnos?: Array<{ abre: string; cierra: string }>; cerrado?: boolean; motivo?: string };
      if (!c.fechaDesde || !c.fechaHasta || c.fechaHasta < c.fechaDesde) return fallo(400, "La fecha final no puede ser anterior a la inicial.");
      const lista = puentes(p);
      for (const branchId of c.branchIds ?? []) {
        lista.push({ id: `puente-${lista.length + 1}`, branchId, fechaDesde: c.fechaDesde, fechaHasta: c.fechaHasta, horario: c.cerrado ? [] : (c.turnos ?? []).map((t) => ({ dias: [0, 1, 2, 3, 4, 5, 6], abre: t.abre, cierra: t.cierra })), motivo: c.motivo ?? null });
      }
      return { puentes: lista };
    },
  },
  {
    metodo: "DELETE",
    patron: `${B}/config/puentes/:puenteId`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const lista = puentes(p);
      const i = lista.findIndex((x) => x.id === p.params["puenteId"]);
      if (i >= 0) lista.splice(i, 1);
      return { ok: true };
    },
  },

  // ---------- Ficha del cliente (Cliente 360): escrituras ----------
  { metodo: "PATCH", patron: `${B}/customers/:customerId`, manejador: () => ({ ok: true }) },
  { metodo: "POST", patron: `${B}/customers/:customerId/addresses`, manejador: () => ({ ok: true }) },
  { metodo: "PATCH", patron: `${B}/customers/:customerId/addresses/:addressId`, manejador: () => ({ ok: true }) },
  { metodo: "DELETE", patron: `${B}/customers/:customerId/addresses/:addressId`, manejador: () => ({ ok: true }) },
  { metodo: "POST", patron: `${B}/customers/:customerId/preferences`, manejador: () => ({ ok: true }) },
  { metodo: "POST", patron: `${B}/customers/:customerId/orders/:orderId/falso`, manejador: () => ({ ok: true }) },
  { metodo: "GET", patron: `${B}/customers/:customerId/arco-export`, roles: ["owner", "admin"], manejador: (p) => ({ datos: { cliente: p.params["customerId"] } }) },
  { metodo: "POST", patron: `${B}/customers/:customerId/borrar-memoria`, roles: ["owner", "admin"], manejador: () => ({ resultado: { domiciliosBorrados: 1, gustosBorrados: 0 } }) },

  // ---------- Callbacks (R-12): intentos y cambios de estado; el GET lee "rest.callbacks" (restaurantes-panel.ts) ----------
  {
    metodo: "POST",
    patron: `${B}/callbacks/:callbackId/intentos`,
    manejador: (p) => {
      const lista = p.estado.obtener<Array<{ id: string; intentos: unknown[] }>>("rest.callbacks", () => []);
      const cb = lista.find((c) => c.id === p.params["callbackId"]);
      if (!cb) return fallo(404, "Callback no encontrado");
      const r = ((p.cuerpo ?? {}) as { resultado?: string }).resultado ?? "no_contesto";
      cb.intentos.push({ id: `int-${cb.intentos.length + 1}`, resultado: r, nota: null, proximoIntentoEn: null, autor: "Owner restaurantes", creadoEn: new Date().toISOString() });
      return { ok: true };
    },
  },
  {
    metodo: "POST",
    patron: `${B}/callbacks/:callbackId/estado`,
    manejador: (p) => {
      const lista = p.estado.obtener<Array<{ id: string; estado: string; resuelto: boolean }>>("rest.callbacks", () => []);
      const cb = lista.find((c) => c.id === p.params["callbackId"]);
      if (!cb) return fallo(404, "Callback no encontrado");
      const accion = ((p.cuerpo ?? {}) as { accion?: string }).accion;
      if (accion === "tomar") cb.estado = "en_curso";
      if (accion === "liberar") cb.estado = "nuevo";
      if (accion === "resolver") { cb.estado = "resuelto"; cb.resuelto = true; }
      if (accion === "reabrir") { cb.estado = "nuevo"; cb.resuelto = false; }
      return { ok: true };
    },
  },

  // ---------- Historial de transiciones de un pedido (A-03) ----------
  {
    metodo: "GET",
    patron: `${B}/autopiloto/pedidos/:orderId/historial`,
    manejador: () => ({ disponible: true, eventos: [{ desde: null, hacia: "pending", actor: "agente", motivo: null, at: "2026-09-30T18:20:00.000Z" }] }),
  },
];
