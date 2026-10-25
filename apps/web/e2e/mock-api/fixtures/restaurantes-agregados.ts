// API simulada de «Agregados por validar» (097) para e2e. Solo existe aqui: la API real (admin-agregados.ts) la prueban apps/api/tests y scripts/verify-restaurantes-agregados.
// Estado en memoria por escenario: aceptar/rechazar se refleja en el GET siguiente; el segundo clic responde `ya_resuelto`. Solo datos sinteticos.
import type { ListaAgregados, TarjetaAgregado } from "../../../../../packages/domain-restaurantes/src/operacion/agregados.ts";
import type { Ruta } from "../tipos.ts";
import { errorApi } from "./operacion-comun.ts";

const BASE = "/v1/restaurantes/:id/admin/agregados";
const CLAVE = "restaurantes.agregados";
const MIN = 60_000;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;

interface Registro {
  tarjeta: TarjetaAgregado;
  solicitadoMs: number;
}

function tarjeta(n: number, extra: Partial<TarjetaAgregado> & { pedidoEstado?: string; yaEnCocina?: boolean }): TarjetaAgregado {
  const ahora = Date.now();
  return {
    id: uuid(n), propertyId: uuid(0), sucursal: "Centro", canal: "whatsapp", estado: "pendiente", estadoEfectivo: "pendiente", sla: { segundosEspera: 0, nivel: "en_tiempo", segundosParaSiguienteUmbral: 600 },
    pedido: { id: uuid(100 + n), numero: 200 + n, estado: extra.pedidoEstado ?? "preparando", yaEnCocina: extra.yaEnCocina ?? true, creadoEn: new Date(ahora - 12 * MIN).toISOString(), renglones: [{ nombre: "Taco de pastor", cantidad: 4 }], total: 100 },
    agregado: { renglones: [{ nombre: "Coca-Cola", cantidad: 2, precio: 45, subtotal: 90 }], total: 90, nuevoTotal: 190, nota: null, version: 1 },
    cliente: { nombre: "Ana R.", telefono: "9995550101" }, solicitadoEn: new Date(ahora).toISOString(), vistoEn: null, resueltoEn: null, resueltoPor: null, motivoRechazo: null, notaRechazo: null, escalamiento: 0,
    ...extra,
  } as TarjetaAgregado;
}

function semilla(): Registro[] {
  const ahora = Date.now();
  return [
    { tarjeta: tarjeta(1, { cliente: { nombre: "Ana R.", telefono: "9995550101" } }), solicitadoMs: ahora - 130_000 },
    { tarjeta: tarjeta(2, { cliente: { nombre: "Luis M.", telefono: "9995550102" }, canal: "llamada", pedidoEstado: "pending", yaEnCocina: false }), solicitadoMs: ahora - 12 * MIN },
  ];
}

function registros(p: { estado: { obtener<T>(c: string, s: () => T): T } }): Registro[] {
  return p.estado.obtener<Registro[]>(CLAVE, semilla);
}

function vivo(r: Registro): TarjetaAgregado {
  if (r.tarjeta.estado !== "pendiente") return r.tarjeta;
  const seg = Math.floor((Date.now() - r.solicitadoMs) / 1000);
  const nivel = seg >= 1200 ? "vencido" : seg >= 600 ? "sin_respuesta" : "en_tiempo";
  return { ...r.tarjeta, solicitadoEn: new Date(r.solicitadoMs).toISOString(), sla: { segundosEspera: seg, nivel, segundosParaSiguienteUmbral: null }, estadoEfectivo: nivel === "vencido" ? "vencido" : "pendiente" };
}

export const rutasRestaurantesAgregados: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: BASE,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const todas = registros(p).map(vivo);
      const reciente = p.query.get("estado") === "recientes";
      const lista = reciente ? todas : todas.filter((t) => t.estado === "pendiente");
      const cuerpo: ListaAgregados = { disponible: true, agregados: lista, pendientes: todas.filter((t) => t.estado === "pendiente").length, ahora: new Date().toISOString() };
      return cuerpo;
    },
  },
  { metodo: "POST", patron: `${BASE}/:agregadoId/visto`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const r = registros(p).find((x) => x.tarjeta.id === p.params["agregadoId"]);
      if (r && !r.tarjeta.vistoEn) r.tarjeta = { ...r.tarjeta, vistoEn: new Date().toISOString() };
      return { ok: true };
    } },
  {
    metodo: "POST",
    patron: `${BASE}/:agregadoId/aceptar`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const r = registros(p).find((x) => x.tarjeta.id === p.params["agregadoId"]);
      if (!r) return errorApi(404, "not_found", "No se encontró ese agregado.");
      if (r.tarjeta.estado !== "pendiente") return { resultado: "ya_resuelto", agregado: vivo(r) };
      r.tarjeta = { ...r.tarjeta, estado: "aceptado", estadoEfectivo: "aceptado", resueltoEn: new Date().toISOString(), resueltoPor: "Persona de prueba", cliente: { ...r.tarjeta.cliente, telefono: null } };
      return { resultado: "aplicado", agregado: r.tarjeta };
    },
  },
  {
    metodo: "POST",
    patron: `${BASE}/:agregadoId/rechazar`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const r = registros(p).find((x) => x.tarjeta.id === p.params["agregadoId"]);
      if (!r) return errorApi(404, "not_found", "No se encontró ese agregado.");
      const cuerpo = (p.cuerpo ?? {}) as { motivo?: string; nota?: string };
      if (!cuerpo.motivo) return errorApi(400, "validation_error", "motivo: debe ser uno de la lista.");
      if (r.tarjeta.estado !== "pendiente") return { resultado: "ya_resuelto", agregado: vivo(r) };
      r.tarjeta = { ...r.tarjeta, estado: "rechazado", estadoEfectivo: "rechazado", motivoRechazo: cuerpo.motivo as TarjetaAgregado["motivoRechazo"], notaRechazo: cuerpo.nota ?? null, resueltoEn: new Date().toISOString(), resueltoPor: "Persona de prueba", cliente: { ...r.tarjeta.cliente, telefono: null } };
      return { resultado: "aplicado", agregado: r.tarjeta };
    },
  },
];
