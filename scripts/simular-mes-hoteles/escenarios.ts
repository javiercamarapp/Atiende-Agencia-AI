// Escenarios de un dia del hotel sintetico. TODO pasa por la API real (app.request) o por las rutas internas de cron con el secreto
// interno; el reloj simulado decide la fecha de negocio que ven el codigo de la app y el worker.
import type { RelojSimulado } from "./reloj.ts";
import { instanteLocalIso, sumarDias } from "./reloj.ts";
import type { Mundo, TipoHab } from "./mundo.ts";
import { TIPOS, ZONA } from "./mundo.ts";
import type { Simulador } from "./sim.ts";

export function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMBRES = ["Ana", "Luis", "Maria", "Carlos", "Sofia", "Jorge", "Lucia", "Pedro", "Elena", "Diego", "Paula", "Raul", "Irene", "Mateo", "Valeria", "Hugo"];
const APELLIDOS = ["Garcia", "Hernandez", "Lopez", "Martinez", "Rodriguez", "Perez", "Sanchez", "Ramirez", "Flores", "Torres", "Vargas", "Castro", "Ortega", "Mendoza"];

export type Comportamiento = "normal" | "cancela_libre" | "cancela_tarde" | "no_show";
export type Canal = "directo" | "agente" | "grupo";

export interface Reserva {
  id: string;
  folioId: string | null;
  tipo: TipoHab["clave"];
  guestId: string;
  apellido: string;
  telefono: string;
  telefonoUlt4: string;
  checkIn: string;
  checkOut: string;
  canal: Canal;
  comportamiento: Comportamiento;
  estado: "confirmada" | "en_estancia" | "cerrada" | "cancelada" | "no_show";
  roomId: string | null;
  creadaDia: number;
  cxc?: boolean;
  cerradaDia?: number;
  cfdiId?: string;
  identidadId?: string;
  purgaSolicitada?: boolean;
}

export interface Contexto {
  readonly sim: Simulador;
  readonly reloj: RelojSimulado;
  readonly mundo: Mundo;
  readonly rng: () => number;
  readonly reservas: Map<string, Reserva>;
  /** Fechas de negocio ya cerradas por el night audit (para los asserts). */
  readonly cerradas: Set<string>;
  readonly secretoInterno: string;
  /** Fecha real (no simulada) de la property al arrancar: para los datos que la base valida contra su now() real. */
  readonly hoyReal: string;
  readonly appSinCredenciales: import("hono").Hono;
  readonly secretoWhatsApp: string;
  readonly phoneNumberId: string;
  /** Reloj simulado (ms) en que corrio el ultimo barrido de SLA: el assert de SLA se evalua a esa hora, no al cierre del dia. */
  ultimoBarridoSlaMs: number | null;
  dia: number;
  fecha: string;
}

export const P = (ctx: Contexto) => `/hoteles/${ctx.mundo.propertyId}`;

function elegir<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

export function ponerHora(ctx: Contexto, hhmm: string): void {
  const iso = instanteLocalIso(ctx.fecha, hhmm, ZONA);
  if (Date.parse(iso) > ctx.reloj.ahoraMs()) ctx.reloj.irA(iso);
  else ctx.reloj.avanzarMinutos(1);
}

function tipoAlAzar(rng: () => number): TipoHab {
  const r = rng();
  return r < 0.45 ? TIPOS[0]! : r < 0.75 ? TIPOS[1]! : r < 0.93 ? TIPOS[2]! : TIPOS[3]!;
}

function comportamientoAlAzar(rng: () => number): Comportamiento {
  const r = rng();
  return r < 0.05 ? "cancela_libre" : r < 0.08 ? "cancela_tarde" : r < 0.12 ? "no_show" : "normal";
}

export async function cron(ctx: Contexto, ruta: string, metodo: "GET" | "POST" = "POST", tipo?: string) {
  return ctx.sim.api(null, metodo, ruta, undefined, { headers: { "x-atiende-internal-secret": ctx.secretoInterno }, actor: "sistema", tipo: tipo ?? `cron ${ruta}` });
}

/** Una reserva directa (reservaciones) con huesped nuevo. Devuelve null si el inventario se agoto (rechazo esperado y registrado). */
export async function reservaDirecta(ctx: Contexto, llegadaOffset: number, noches: number, canal: Canal = "directo"): Promise<Reserva | null> {
  const { sim, rng } = ctx;
  const tipo = tipoAlAzar(rng);
  const nombre = elegir(rng, NOMBRES);
  const apellido = elegir(rng, APELLIDOS);
  const tel = `998555${String(Math.floor(rng() * 10000)).padStart(4, "0")}`;
  const g = await sim.api("reservations", "POST", `${P(ctx)}/huespedes`, { nombreCompleto: `${nombre} ${apellido}`, email: `${nombre}.${apellido}.${ctx.reservas.size}@example.test`.toLowerCase(), telefono: tel }, { tipo: "huesped.alta", detalle: { canal } });
  if (g.status !== 201) return null;
  const checkIn = sumarDias(ctx.fecha, llegadaOffset);
  const checkOut = sumarDias(checkIn, noches);
  const tipoId = ctx.mundo.tipos[tipo.clave].id;
  const r = await sim.api(
    "reservations",
    "POST",
    `${P(ctx)}/reservas`,
    { roomTypeId: tipoId, checkInDate: checkIn, checkOutDate: checkOut, guestId: g.json.id },
    { idem: sim.nuevaClaveIdem("reserva"), esperado: [201, 409], tipo: "reserva.directa", detalle: { tipo: tipo.clave, noches, llegada: checkIn, canal } },
  );
  if (r.status === 409) {
    sim.evento("reserva.rechazada_inventario", "staff", true, 409, { tipo: tipo.clave, llegada: checkIn, code: String(r.json?.code ?? "") });
    return null;
  }
  const res: Reserva = {
    id: r.json.id,
    folioId: null,
    tipo: tipo.clave,
    guestId: g.json.id,
    apellido,
    telefono: tel,
    telefonoUlt4: tel.slice(-4),
    checkIn,
    checkOut,
    canal,
    comportamiento: comportamientoAlAzar(rng),
    estado: "confirmada",
    roomId: null,
    creadaDia: ctx.dia,
  };
  ctx.reservas.set(res.id, res);
  return res;
}

async function folioDe(ctx: Contexto, r: Reserva): Promise<string> {
  if (r.folioId) return r.folioId;
  const f = await ctx.sim.api("frontdesk", "GET", `${P(ctx)}/reservas/${r.id}/folios`, undefined, { silencioso: true });
  r.folioId = f.json?.[0]?.id ?? null;
  if (!r.folioId) throw new Error(`reserva ${r.id} sin folio primario`);
  return r.folioId;
}

/** Limpieza: genera las tareas del dia, las toma housekeeping y las inspecciona el gerente (separacion de funciones). */
export async function limpiezaDelDia(ctx: Contexto, etiqueta: string): Promise<void> {
  const { sim } = ctx;
  await sim.api("frontdesk", "POST", `${P(ctx)}/housekeeping/tareas/generar`, { fecha: ctx.fecha }, { tipo: `housekeeping.generar.${etiqueta}`, esperado: [201] });
  const lista = await sim.api("housekeeping", "GET", `${P(ctx)}/housekeeping/tareas?fecha=${ctx.fecha}`, undefined, { silencioso: true });
  const camarista = ctx.mundo.staff.housekeeping.id;
  let hechas = 0;
  for (const t of lista.json?.tareas ?? []) {
    if (t.estado === "inspeccionada" || t.estado === "cancelada") continue;
    if (t.estado === "pendiente") {
      if (t.asignadoA && t.asignadoA !== camarista) continue;
      await sim.api("housekeeping", "POST", `${P(ctx)}/housekeeping/tareas/${t.id}/iniciar`, {}, { silencioso: true, esperado: [200, 409] });
      ctx.reloj.avanzarMinutos(3);
    }
    await sim.api("housekeeping", "POST", `${P(ctx)}/housekeeping/tareas/${t.id}/terminar`, {}, { silencioso: true, esperado: [200, 409] });
    const ins = await sim.api("gm", "POST", `${P(ctx)}/housekeeping/tareas/${t.id}/inspeccionar`, { aprobada: true }, { silencioso: true, esperado: [200, 409] });
    if (ins.status === 200) hechas += 1;
  }
  sim.evento(`housekeeping.limpieza.${etiqueta}`, "staff", true, 200, { tareasInspeccionadas: hechas });
}

export async function habitacionDisponible(ctx: Contexto, tipo: TipoHab["clave"], ocupadas: Set<string>): Promise<string | null> {
  const lista = await ctx.sim.api("frontdesk", "GET", `${P(ctx)}/habitaciones?roomTypeId=${ctx.mundo.tipos[tipo].id}`, undefined, { silencioso: true });
  const libre = (lista.json ?? []).find((h: { id: string; estado: string }) => h.estado === "disponible" && !ocupadas.has(h.id));
  return libre?.id ?? null;
}

export async function llegadas(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  const hoy = [...ctx.reservas.values()].filter((r) => r.estado === "confirmada" && r.checkIn === ctx.fecha && r.comportamiento !== "no_show" && r.comportamiento !== "cancela_libre" && r.comportamiento !== "cancela_tarde");
  const enCasa = new Set([...ctx.reservas.values()].filter((r) => r.estado === "en_estancia" && r.roomId).map((r) => r.roomId!));
  for (const r of hoy) {
    const roomId = await habitacionDisponible(ctx, r.tipo, enCasa);
    if (!roomId) {
      const todas = await sim.api("frontdesk", "GET", `${P(ctx)}/habitaciones?roomTypeId=${ctx.mundo.tipos[r.tipo].id}`, undefined, { silencioso: true });
      const estados: Record<string, number> = {};
      for (const h of (todas.json ?? []) as { estado: string }[]) estados[h.estado] = (estados[h.estado] ?? 0) + 1;
      sim.evento("checkin.sin_habitacion_lista", "staff", false, null, { reserva: r.id.slice(0, 8), tipo: r.tipo, estadosDelTipo: JSON.stringify(estados) });
      continue;
    }
    const res = await sim.api("frontdesk", "POST", `${P(ctx)}/recepcion/reservas/${r.id}/check-in`, { roomId }, { tipo: "checkin", detalle: { tipo: r.tipo, habitacion: roomId.slice(0, 8) } });
    if (res.status === 200) {
      r.estado = "en_estancia";
      r.roomId = roomId;
      enCasa.add(roomId);
      await folioDe(ctx, r);
    }
    ctx.reloj.avanzarMinutos(4);
  }
}

export async function cargosDeEstancia(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const enCasa = [...ctx.reservas.values()].filter((r) => r.estado === "en_estancia");
  for (const r of enCasa) {
    if (rng() > 0.55) continue;
    const folioId = await folioDe(ctx, r);
    const monto = 120 + Math.floor(rng() * 480);
    const concepto = rng() < 0.7 ? "ab" : "extras";
    await sim.api("fnb", "POST", `${P(ctx)}/folios/${folioId}/cargos`, { descripcion: concepto === "ab" ? "Restaurante" : "Lavanderia", monto, concepto, verificacionIdentidad: { apellido: r.apellido, telefonoUlt4: r.telefonoUlt4 } }, { idem: sim.nuevaClaveIdem("cargo"), tipo: "folio.cargo", detalle: { concepto, monto } });
    ctx.reloj.avanzarMinutos(2);
  }
}

export async function salidas(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const hoy = [...ctx.reservas.values()].filter((r) => r.estado === "en_estancia" && r.checkOut === ctx.fecha);
  for (const r of hoy) {
    const folioId = await folioDe(ctx, r);
    const f = await sim.api("frontdesk", "GET", `${P(ctx)}/folios/${folioId}`, undefined, { silencioso: true });
    const saldo: number = f.json.saldo;
    if (saldo > 0) {
      const x = rng();
      const metodo = x < 0.4 ? "efectivo" : x < 0.85 ? "tarjeta" : "transferencia";
      const cuerpo: Record<string, unknown> = { monto: saldo, metodo };
      if (metodo === "tarjeta") cuerpo.tokenPago = `tok_sim_${r.id.slice(0, 8)}`;
      if (metodo === "transferencia") cuerpo.referenciaExterna = `SPEI-${r.id.slice(0, 8)}`;
      await sim.api("frontdesk", "POST", `${P(ctx)}/folios/${folioId}/pagos`, cuerpo, { idem: sim.nuevaClaveIdem("pago"), tipo: "folio.pago", detalle: { metodo, monto: saldo } });
    }
    const out = await sim.api("frontdesk", "POST", `${P(ctx)}/recepcion/reservas/${r.id}/check-out`, {}, { tipo: "checkout" });
    if (out.status !== 200) continue;
    await sim.api("frontdesk", "POST", `${P(ctx)}/folios/${folioId}/cerrar`, { motivo: "saldo_cero" }, { tipo: "folio.cierre", detalle: { motivo: "saldo_cero" } });
    r.estado = "cerrada";
    r.cerradaDia = ctx.dia;
    ctx.reloj.avanzarMinutos(5);
  }
}

export async function cancelaciones(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  for (const r of ctx.reservas.values()) {
    if (r.estado !== "confirmada") continue;
    const libre = r.comportamiento === "cancela_libre" && r.checkIn >= sumarDias(ctx.fecha, 3) && r.creadaDia < ctx.dia;
    const tarde = r.comportamiento === "cancela_tarde" && r.checkIn === sumarDias(ctx.fecha, 1);
    if (!libre && !tarde) continue;
    const res = await sim.api("reservations", "POST", `${P(ctx)}/reservas/${r.id}/cancelar`, { motivo: libre ? "cambio de planes" : "cancelacion tardia" }, { tipo: libre ? "reserva.cancelacion_libre" : "reserva.cancelacion_con_penalizacion", detalle: { llegada: r.checkIn } });
    if (res.status === 200 || res.status === 201) r.estado = "cancelada";
    ctx.reloj.avanzarMinutos(2);
  }
}

export async function precarga(ctx: Contexto, reservasIniciales: number): Promise<void> {
  ctx.sim.olvidarTokens();
  ponerHora(ctx, "09:00");
  for (let i = 0; i < reservasIniciales; i++) {
    await reservaDirecta(ctx, 1 + Math.floor(ctx.rng() * 9), 1 + Math.floor(ctx.rng() * 4));
    ctx.reloj.avanzarMinutos(2);
  }
}
