// Generador de la plantilla (Fase A): config -> prompt de WhatsApp, comportamiento de voz y seed. Reutiliza `buildPmSystemPrompt` y
// `comportamientoVozPm` (una sola fuente de reglas); lo especifico del negocio entra como datos por `contextoNegocio`.
import { comportamientoVozPm } from "../voz/perfil-voz-pm.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt, type PerfilPmContexto } from "../whatsapp/perfil-pm.ts";
import { WHATSAPP_AGENT_LIMITES, slugify } from "../seed/pm-demo.ts";
import { validarHorario, type HorarioSucursal } from "../horarios.ts";
import type { BranchSummary } from "../types.ts";
import type { RestauranteConfig } from "./tipos.ts";
import { validarConfig, type OpcionesValidacion } from "./validar.ts";

export class ConfigInvalidaError extends Error {
  constructor(readonly errores: readonly string[]) {
    super(`Config de restaurante invalida: ${errores.join(" | ")}`);
  }
}

type CamposNegocio = Pick<PerfilPmContexto, "giroTexto" | "articuloGiro" | "ubicacionTexto" | "zonaHorariaTexto" | "pedidoMinimo" | "pedidoGrandeTexto" | "propinaPolitica" | "transferencia">;

/** Los datos del negocio que el prompt ya sabe leer (sin tocar los de PM: valores iguales a los historicos dan el mismo texto). */
export function contextoNegocio(c: RestauranteConfig): CamposNegocio {
  return {
    giroTexto: c.negocio.giro,
    articuloGiro: c.negocio.articuloGiro,
    ubicacionTexto: c.negocio.ciudad,
    zonaHorariaTexto: c.negocio.zonaHoraria,
    pedidoMinimo: c.politicas.pedidoMinimoDomicilio,
    pedidoGrandeTexto: c.politicas.pedidoGrandeTexto,
    propinaPolitica: c.politicas.propina,
    transferencia: c.politicas.transferencia,
  };
}

function exigir(c: RestauranteConfig, op: OpcionesValidacion): void {
  const v = validarConfig(c, op);
  if (!v.ok) throw new ConfigInvalidaError(v.errores);
}

export function sucursalesResumen(c: RestauranteConfig): readonly BranchSummary[] {
  return c.sucursales.filter((s) => s.activa).map((s, i) => ({ propertyId: `p${i}`, slug: s.slug, name: s.nombre, address: s.direccion }));
}

export interface EntradaWhatsApp {
  /** Reloj y cliente los pone el servidor en cada turno. */
  readonly saludo?: string;
  readonly branches?: readonly BranchSummary[];
  readonly entryBranch?: PerfilPmContexto["entryBranch"];
  readonly customer?: PerfilPmContexto["customer"];
  readonly fechaHoraLocal?: string;
  readonly diaSemana?: string;
  readonly estadoSucursalAhora?: string;
  readonly conocimientoBloque?: string;
  readonly prefijoEstable?: boolean;
  readonly agregadosActivos?: boolean;
  readonly canal?: "whatsapp" | "voz";
}

/** Prompt de WhatsApp de la instancia. Para PM da el mismo texto que el armado historico. */
export function generarPromptWhatsApp(c: RestauranteConfig, e: EntradaWhatsApp = {}, op: OpcionesValidacion = {}): string {
  exigir(c, op);
  const ctx: PerfilPmContexto = {
    businessName: c.marca.nombre,
    agentName: c.marca.agente ?? PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: c.marca.tiempoEntrega,
    saludo: e.saludo ?? "",
    branches: e.branches ?? sucursalesResumen(c),
    entryBranch: e.entryBranch ?? null,
    customer: e.customer ?? { isNew: true },
    saludoPersonalizado: c.marca.saludo,
    salsasTexto: c.politicas.salsasTexto,
    promosTexto: c.politicas.promosTexto,
    motivosDesactivados: c.politicas.motivosDesactivados,
    urlFacturacion: c.politicas.urlFacturacion,
    ...contextoNegocio(c),
    ...(e.fechaHoraLocal !== undefined ? { fechaHoraLocal: e.fechaHoraLocal } : {}),
    ...(e.diaSemana !== undefined ? { diaSemana: e.diaSemana } : {}),
    ...(e.estadoSucursalAhora !== undefined ? { estadoSucursalAhora: e.estadoSucursalAhora } : {}),
    ...(e.conocimientoBloque !== undefined ? { conocimientoBloque: e.conocimientoBloque } : {}),
    ...(e.prefijoEstable !== undefined ? { prefijoEstable: e.prefijoEstable } : {}),
    ...(e.agregadosActivos !== undefined ? { agregadosActivos: e.agregadosActivos } : {}),
    ...(e.canal !== undefined ? { canal: e.canal } : {}),
  };
  return buildPmSystemPrompt(ctx);
}

/** Comportamiento de voz (texto fijo de `branch_voice_config.comportamiento`, <= 8000 caracteres). */
export function generarComportamientoVoz(c: RestauranteConfig, op: OpcionesValidacion = {}): string {
  exigir(c, op);
  return comportamientoVozPm({
    businessName: c.marca.nombre,
    agentName: c.marca.agente ?? PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: c.marca.tiempoEntrega,
    branches: sucursalesResumen(c),
    salsasTexto: c.politicas.salsasTexto,
    promosTexto: c.politicas.promosTexto,
    motivosDesactivados: c.politicas.motivosDesactivados,
    negocio: contextoNegocio(c),
  });
}

// --- Seed ---------------------------------------------------------------------------------------------------------------------------

export interface SeedSucursal {
  readonly slug: string;
  readonly nombre: string;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly activa: boolean;
  readonly reparte: boolean;
  readonly horario: HorarioSucursal;
}
export interface SeedProducto {
  readonly nombre: string;
  readonly slug: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  readonly esAlcohol: boolean;
  readonly popular: boolean;
  readonly alias: readonly string[];
  /** slug de sucursal -> precio. Toda sucursal ACTIVA vende el producto. */
  readonly preciosPorSucursal: Readonly<Record<string, number>>;
}
export interface SeedRestaurante {
  readonly organizacion: { readonly slug: string; readonly nombre: string };
  readonly agenteWhatsApp: { readonly businessName: string; readonly agentName: string; readonly deliveryTimeText: string; readonly salsasText: string | null; readonly promosText: string | null; readonly largeOrderText: string | null };
  readonly voz: { readonly habilitada: boolean; readonly comportamiento: string };
  readonly sucursales: readonly SeedSucursal[];
  readonly categorias: readonly string[];
  readonly productos: readonly SeedProducto[];
  readonly promociones: PromocionesSeed;
  readonly conocimiento: RestauranteConfig["conocimiento"];
}
type PromocionesSeed = RestauranteConfig["promociones"];

/** Seed determinista y puro de la instancia (no abre conexiones; el SQL lo emiten los renderizadores existentes en fases siguientes). */
export function generarSeed(c: RestauranteConfig, op: OpcionesValidacion = {}): SeedRestaurante {
  exigir(c, op);
  const L = WHATSAPP_AGENT_LIMITES;
  const agent = c.marca.agente ?? PM_AGENT_NAME_POR_OMISION;
  if (c.marca.nombre.length > L.businessName || agent.length > L.agentName || c.marca.tiempoEntrega.length > L.deliveryTimeText) throw new ConfigInvalidaError(["Un texto del agente excede el limite de la columna."]);
  for (const [k, v, max] of [["salsasTexto", c.politicas.salsasTexto, L.salsasText], ["promosTexto", c.politicas.promosTexto, L.promosText]] as const) {
    if (v !== null && v.length > max) throw new ConfigInvalidaError([`${k} excede ${max} caracteres.`]);
  }
  const activas = c.sucursales.filter((s) => s.activa).map((s) => s.slug);
  const comportamiento = generarComportamientoVoz(c, op);
  return {
    organizacion: { slug: c.slug, nombre: c.marca.nombre },
    agenteWhatsApp: { businessName: c.marca.nombre, agentName: agent, deliveryTimeText: c.marca.tiempoEntrega, salsasText: c.politicas.salsasTexto, promosText: c.politicas.promosTexto, largeOrderText: c.politicas.pedidoGrandeTexto },
    voz: { habilitada: c.voz.habilitada, comportamiento },
    sucursales: c.sucursales.map((s) => ({ slug: s.slug, nombre: s.nombre, direccion: s.direccion, telefono: s.telefono, activa: s.activa, reparte: s.reparte, horario: validarHorario(s.horario) })),
    categorias: [...c.menu.categorias],
    productos: c.menu.productos.map((p) => ({
      nombre: p.nombre,
      slug: slugify(p.nombre),
      categoria: p.categoria,
      descripcion: p.descripcion ?? null,
      esAlcohol: p.esAlcohol === true,
      popular: p.popular === true,
      alias: [...(p.alias ?? [])],
      preciosPorSucursal: Object.fromEntries(activas.map((sl) => [sl, p.precioPorSucursal?.[sl] ?? p.precio])),
    })),
    promociones: c.promociones,
    conocimiento: c.conocimiento,
  };
}
