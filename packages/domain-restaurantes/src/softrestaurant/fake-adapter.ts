// Adaptador FALSO de SoftRestaurant: determinista, en memoria, con inyeccion de
// fallos. Sirve para pruebas de dominio/outbox/rutas y como referencia ejecutable
// del contrato. NUNCA es un POS real: `esReal = false`, y su catalogo usa codigos
// sinteticos `FAKE-###` (`CatalogoPos.sintetico = true`), porque el menu real con
// codigos aun no llega (`pm/brechas.md` A1).
//
// Determinismo: sin azar ni relojes ocultos. Los folios son `<sucursal>-<n>` con un
// contador por sucursal; el reloj es inyectable.
import {
  SoftRestaurantNoDisponibleError,
  esSucursalPos,
  validarComandaInput,
  type CatalogoPos,
  type CausaNoDisponible,
  type ComandaInput,
  type ComandaResultado,
  type ConsultaEstadoComanda,
  type EstadoComandaPos,
  type ItemCatalogoPos,
  type PedidoHistorialPos,
  type SaludPos,
  type SoftRestaurantPort,
  type SucursalPos,
} from "./types.ts";

export type FallaInyectable =
  /** El POS no responde a tiempo. La comanda NO se crea. */
  | { readonly tipo: "timeout" }
  /** El POS responde 5xx. La comanda NO se crea. */
  | { readonly tipo: "http_5xx" }
  /**
   * El POS SI crea la comanda pero la respuesta se pierde (timeout de lectura). Es el
   * caso que hace indispensable la idempotencia: el reintento debe devolver el mismo
   * folio con `duplicada = true`, nunca una segunda comanda.
   */
  | { readonly tipo: "duplicado" }
  /** El POS rechaza por codigo inexistente (catalogo desfasado). */
  | { readonly tipo: "producto_inexistente" };

export type MetodoFalso = "crearComanda" | "syncCatalog" | "obtenerHistorialPorTelefono" | "obtenerEstadoComanda" | "salud";

export interface ComandaGuardada {
  readonly folio: string;
  readonly input: ComandaInput;
  readonly creadaEn: string;
  estado: EstadoComandaPos;
}

/** Catalogo sintetico minimo (codigos FAKE-###). No son productos reales de PM. */
export const CATALOGO_FALSO_ITEMS: readonly ItemCatalogoPos[] = [
  { codigo: "FAKE-001", nombre: "Orden de tacos de pastor", precio: 90, categoria: "Tacos", disponible: true, modificadores: [{ codigo: "FAKE-MOD-001", nombre: "Sin cebolla", precioExtra: 0 }, { codigo: "FAKE-MOD-002", nombre: "Con queso", precioExtra: 15 }] },
  { codigo: "FAKE-002", nombre: "Orden de tacos de bistec", precio: 110, categoria: "Tacos", disponible: true, modificadores: [{ codigo: "FAKE-MOD-001", nombre: "Sin cebolla", precioExtra: 0 }] },
  { codigo: "FAKE-003", nombre: "Refresco", precio: 30, categoria: "Bebidas", disponible: true, modificadores: [] },
  { codigo: "FAKE-004", nombre: "Agua de horchata", precio: 35, categoria: "Bebidas", disponible: true, modificadores: [] },
];

export interface OpcionesFakeSoftRestaurant {
  readonly catalogo?: readonly ItemCatalogoPos[];
  readonly ahora?: () => Date;
  /** Latencia simulada en ms que se reporta en `salud()` (no hay espera real). */
  readonly latenciaSimuladaMs?: number;
}

export class FakeSoftRestaurantAdapter implements SoftRestaurantPort {
  readonly nombre = "fake";
  readonly esReal = false;

  readonly comandas: ComandaGuardada[] = [];
  /** Cada llamada a `crearComanda`, en orden (incluye las que fallaron). */
  readonly llamadasCrear: ComandaInput[] = [];

  private readonly porLlave = new Map<string, ComandaGuardada>();
  private readonly contadores = new Map<SucursalPos, number>();
  private readonly fallas = new Map<MetodoFalso, FallaInyectable[]>();
  private readonly catalogo: readonly ItemCatalogoPos[];
  private readonly ahora: () => Date;
  private readonly latenciaMs: number;
  private saludForzada: boolean | null = null;

  constructor(opciones: OpcionesFakeSoftRestaurant = {}) {
    this.catalogo = opciones.catalogo ?? CATALOGO_FALSO_ITEMS;
    this.ahora = opciones.ahora ?? (() => new Date());
    this.latenciaMs = opciones.latenciaSimuladaMs ?? 5;
  }

  /** Encola una falla para la proxima(s) `veces` llamada(s) a `metodo` (FIFO). */
  inyectarFalla(metodo: MetodoFalso, falla: FallaInyectable, veces = 1): void {
    const cola = this.fallas.get(metodo) ?? [];
    for (let i = 0; i < veces; i += 1) cola.push(falla);
    this.fallas.set(metodo, cola);
  }

  limpiarFallas(): void {
    this.fallas.clear();
    this.saludForzada = null;
  }

  forzarSalud(ok: boolean | null): void {
    this.saludForzada = ok;
  }

  /** Cambia el estado de una comanda (simula que cocina/caja avanzan la cuenta). */
  avanzarEstado(folio: string, estado: EstadoComandaPos): void {
    const c = this.comandas.find((x) => x.folio === folio);
    if (!c) throw new Error(`FakeSoftRestaurantAdapter: folio ${folio} no existe`);
    c.estado = estado;
  }

  private siguienteFalla(metodo: MetodoFalso): FallaInyectable | undefined {
    return this.fallas.get(metodo)?.shift();
  }

  private folioNuevo(sucursal: SucursalPos): string {
    const n = (this.contadores.get(sucursal) ?? 0) + 1;
    this.contadores.set(sucursal, n);
    return `${sucursal}-${String(n).padStart(6, "0")}`;
  }

  private lanzarSiFalla(metodo: MetodoFalso): void {
    const falla = this.siguienteFalla(metodo);
    if (!falla) return;
    const causa: CausaNoDisponible = falla.tipo === "http_5xx" ? "http_5xx" : "timeout";
    throw new SoftRestaurantNoDisponibleError(causa);
  }

  async syncCatalog(sucursal: SucursalPos): Promise<CatalogoPos> {
    this.lanzarSiFalla("syncCatalog");
    if (!esSucursalPos(sucursal)) throw new Error(`sucursal invalida: ${String(sucursal)}`);
    return { sucursal, items: this.catalogo, generadoEn: this.ahora().toISOString(), sintetico: true };
  }

  async crearComanda(input: ComandaInput): Promise<ComandaResultado> {
    this.llamadasCrear.push(input);
    const falla = this.siguienteFalla("crearComanda");

    if (falla?.tipo === "timeout") return { status: "no_disponible", causa: "timeout" };
    if (falla?.tipo === "http_5xx") return { status: "no_disponible", causa: "http_5xx" };
    if (falla?.tipo === "producto_inexistente") {
      return {
        status: "rechazada",
        motivo: "producto_inexistente",
        detalle: "El POS no reconoce uno o mas codigos (catalogo desfasado)",
        codigos: input.items.map((i) => i.codigo),
      };
    }

    const errores = validarComandaInput(input);
    if (errores.length > 0) {
      const sucursalInvalida = !esSucursalPos(input.sucursal);
      return { status: "rechazada", motivo: sucursalInvalida ? "sucursal_invalida" : "entrada_invalida", detalle: errores.join("; ") };
    }

    // Idempotencia: la misma llave devuelve la misma comanda, sin crear otra.
    const existente = this.porLlave.get(input.idempotencyKey);
    if (existente) {
      return { status: "creada", folio: existente.folio, duplicada: true, impresaEnCocina: true };
    }

    const codigosValidos = new Set(this.catalogo.filter((i) => i.disponible).map((i) => i.codigo));
    const desconocidos = input.items.filter((i) => !codigosValidos.has(i.codigo)).map((i) => i.codigo);
    if (desconocidos.length > 0) {
      return { status: "rechazada", motivo: "producto_inexistente", detalle: `Codigos desconocidos: ${desconocidos.join(", ")}`, codigos: desconocidos };
    }
    const modsPorItem = new Map(this.catalogo.map((i) => [i.codigo, new Set(i.modificadores.map((m) => m.codigo))]));
    for (const item of input.items) {
      const permitidos = modsPorItem.get(item.codigo) ?? new Set<string>();
      const malos = item.modificadores.filter((m) => !permitidos.has(m.codigo)).map((m) => m.codigo);
      if (malos.length > 0) {
        return { status: "rechazada", motivo: "producto_inexistente", detalle: `Modificadores desconocidos para ${item.codigo}: ${malos.join(", ")}`, codigos: malos };
      }
    }

    const guardada: ComandaGuardada = {
      folio: this.folioNuevo(input.sucursal),
      input,
      creadaEn: this.ahora().toISOString(),
      estado: "abierta",
    };
    this.comandas.push(guardada);
    this.porLlave.set(input.idempotencyKey, guardada);

    // La comanda existe en el POS pero la respuesta se pierde: el llamador ve un timeout.
    if (falla?.tipo === "duplicado") return { status: "no_disponible", causa: "timeout" };

    return { status: "creada", folio: guardada.folio, duplicada: false, impresaEnCocina: true };
  }

  async obtenerHistorialPorTelefono(input: { readonly telefono: string; readonly limite: number }): Promise<readonly PedidoHistorialPos[]> {
    this.lanzarSiFalla("obtenerHistorialPorTelefono");
    const limite = Math.max(0, Math.min(50, Math.trunc(input.limite)));
    return this.comandas
      .filter((c) => c.input.cliente.telefono === input.telefono)
      .slice()
      .reverse()
      .slice(0, limite)
      .map((c) => ({ folio: c.folio, fecha: c.creadaEn, sucursal: c.input.sucursal, tipo: c.input.tipo, items: c.input.items }));
  }

  async obtenerEstadoComanda(input: { readonly sucursal: SucursalPos; readonly folio: string }): Promise<ConsultaEstadoComanda> {
    this.lanzarSiFalla("obtenerEstadoComanda");
    const c = this.comandas.find((x) => x.folio === input.folio && x.input.sucursal === input.sucursal);
    if (!c) return { encontrada: false };
    return { encontrada: true, folio: c.folio, estado: c.estado, impresaEnCocina: true };
  }

  async salud(): Promise<SaludPos> {
    const falla = this.siguienteFalla("salud");
    const ok = falla === undefined && this.saludForzada !== false;
    return { ok, latenciaMs: this.latenciaMs, ...(ok ? {} : { detalle: "falla simulada" }), chequeadoEn: this.ahora().toISOString() };
  }
}

/**
 * Puerto que representa "no hay adaptador real configurado". Lo usa produccion hasta
 * que el distribuidor entregue la API: `crearComanda` devuelve `no_disponible` con
 * causa `no_configurado` (nunca un folio), asi un modo "activo" prendido por error
 * termina en captura manual en vez de fingir exito.
 */
export class SoftRestaurantNoConfiguradoPort implements SoftRestaurantPort {
  readonly nombre = "no_configurado";
  readonly esReal = false;
  constructor(private readonly ahora: () => Date = () => new Date()) {}

  async syncCatalog(): Promise<CatalogoPos> {
    throw new SoftRestaurantNoDisponibleError("no_configurado");
  }
  async crearComanda(): Promise<ComandaResultado> {
    return { status: "no_disponible", causa: "no_configurado" };
  }
  async obtenerHistorialPorTelefono(): Promise<readonly PedidoHistorialPos[]> {
    throw new SoftRestaurantNoDisponibleError("no_configurado");
  }
  async obtenerEstadoComanda(): Promise<ConsultaEstadoComanda> {
    throw new SoftRestaurantNoDisponibleError("no_configurado");
  }
  async salud(): Promise<SaludPos> {
    return { ok: false, latenciaMs: 0, detalle: "adaptador de SoftRestaurant no configurado", chequeadoEn: this.ahora().toISOString() };
  }
}
