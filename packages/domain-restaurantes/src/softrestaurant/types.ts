// SoftRestaurant (POS de Los Tacos de PM) -- tipos del puerto hexagonal.
//
// La API real de SoftRestaurant AUN NO existe para nosotros (la dara el
// distribuidor, `pm/brechas.md` A3). Todo lo que sigue es el CONTRATO que el
// adaptador real deberá cumplir: dominio, outbox y rutas solo dependen de estos
// tipos, nunca de un proveedor concreto.
//
// Reglas de negocio que el contrato codifica (cuestionario PM, "Recoger y
// domicilio" y "Equipo y handoff"):
//   - La comanda se crea en el POS ANTES de cobrar y NUNCA cobra: el cobro lo
//     hace caja o el repartidor. Por eso `ComandaInput` no tiene ningun campo de
//     "pagado"/"monto cobrado": solo la FORMA de pago declarada.
//   - La comanda sale tambien a la impresora de cocina (`impresaEnCocina`).
//   - Sucursales T1..T8 (activas hoy: T1, T2, T3, T7, T8).
//   - Propina solo con tarjeta.
//   - El agente NUNCA inventa un folio: el folio solo existe si el POS lo devolvio.

export const SUCURSALES_POS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"] as const;
export type SucursalPos = (typeof SUCURSALES_POS)[number];

export type TipoComanda = "domicilio" | "recoger";
export type FormaPagoComanda = "efectivo" | "tarjeta";

export interface ModificadorComanda {
  /** Codigo del modificador en el POS (p. ej. "MOD-SIN-CEBOLLA"). */
  readonly codigo: string;
  readonly nombre?: string;
}

export interface ItemComanda {
  /** Codigo del producto en el POS. Nunca un id de Atiende. */
  readonly codigo: string;
  /** Entero > 0. */
  readonly cantidad: number;
  readonly modificadores: readonly ModificadorComanda[];
  readonly nota?: string;
}

export interface ClienteComanda {
  readonly nombre: string;
  /** Telefono canonico (10 digitos MX o E.164). */
  readonly telefono: string;
}

export interface DireccionComanda {
  /** Direccion completa (calle, numero, colonia). */
  readonly texto: string;
  readonly colonia?: string;
  readonly referencias?: string;
}

export interface ComandaInput {
  /** Llave de idempotencia: el POS debe devolver la MISMA comanda si la recibe dos veces. */
  readonly idempotencyKey: string;
  readonly sucursal: SucursalPos;
  readonly tipo: TipoComanda;
  readonly cliente: ClienteComanda;
  /** Obligatoria para `domicilio`. */
  readonly direccion?: DireccionComanda;
  readonly formaPago: FormaPagoComanda;
  /** Monto en pesos. Solo valido con `formaPago = "tarjeta"`. */
  readonly propina?: number;
  readonly items: readonly ItemComanda[];
  readonly notas?: string;
  /** ISO 8601. Hora compromiso (recoger) o estimada (domicilio). */
  readonly horaCompromiso?: string;
}

export type MotivoRechazoComanda =
  | "producto_inexistente"
  | "sucursal_invalida"
  | "entrada_invalida"
  | "sucursal_cerrada"
  | "otro";

export type CausaNoDisponible = "timeout" | "http_5xx" | "red" | "no_configurado" | "desconocida";

/**
 * Resultado de `crearComanda`. El puerto NO lanza por fallas operativas del POS:
 * las devuelve como `rechazada` (el POS respondio y dijo que no: reintentar igual
 * no sirve) o `no_disponible` (no se pudo hablar con el POS: reintentar si sirve).
 */
export type ComandaResultado =
  | {
      readonly status: "creada";
      readonly folio: string;
      /** true si el POS ya tenia esta idempotencyKey (reenvio): mismo folio, sin comanda nueva. */
      readonly duplicada: boolean;
      readonly impresaEnCocina: boolean;
    }
  | {
      readonly status: "rechazada";
      readonly motivo: MotivoRechazoComanda;
      readonly detalle: string;
      /** Codigos que el POS no reconocio (motivo `producto_inexistente`). */
      readonly codigos?: readonly string[];
    }
  | { readonly status: "no_disponible"; readonly causa: CausaNoDisponible };

export interface ModificadorPos {
  readonly codigo: string;
  readonly nombre: string;
  readonly precioExtra: number;
}

export interface ItemCatalogoPos {
  readonly codigo: string;
  readonly nombre: string;
  readonly precio: number;
  readonly categoria?: string;
  readonly modificadores: readonly ModificadorPos[];
  readonly disponible: boolean;
}

export interface CatalogoPos {
  readonly sucursal: SucursalPos;
  readonly items: readonly ItemCatalogoPos[];
  /** ISO 8601. */
  readonly generadoEn: string;
  /** true si los codigos son sinteticos (adaptador falso). El real NUNCA lo marca. */
  readonly sintetico: boolean;
}

export interface PedidoHistorialPos {
  readonly folio: string;
  /** ISO 8601. */
  readonly fecha: string;
  readonly sucursal: SucursalPos;
  readonly tipo: TipoComanda;
  readonly items: readonly ItemComanda[];
  readonly total?: number;
}

export type EstadoComandaPos = "abierta" | "en_preparacion" | "lista" | "entregada" | "cobrada" | "cancelada";

export type ConsultaEstadoComanda =
  | { readonly encontrada: true; readonly folio: string; readonly estado: EstadoComandaPos; readonly impresaEnCocina: boolean }
  | { readonly encontrada: false };

export interface SaludPos {
  readonly ok: boolean;
  /** Latencia medida del chequeo, en ms. */
  readonly latenciaMs: number;
  readonly detalle?: string;
  /** ISO 8601. */
  readonly chequeadoEn: string;
}

/**
 * Puerto que el dominio usa para hablar con SoftRestaurant. Implementaciones:
 * `FakeSoftRestaurantAdapter` (hoy, pruebas) y, cuando el distribuidor entregue la
 * API, un adaptador real. Ambos deben pasar la suite de contrato
 * (`contract.ts::runSoftRestaurantPortContract`).
 *
 * Convencion de errores: `crearComanda` NUNCA lanza por fallas del POS (devuelve
 * `rechazada`/`no_disponible`). Los metodos de lectura lanzan
 * `SoftRestaurantNoDisponibleError` si no se pudo hablar con el POS.
 */
export interface SoftRestaurantPort {
  /** Nombre corto del adaptador para logs/bitacora ("fake", "http", ...). */
  readonly nombre: string;
  /** false para el falso y para el "no configurado": las rutas lo usan para no prender el modo activo sin POS real. */
  readonly esReal: boolean;
  syncCatalog(sucursal: SucursalPos): Promise<CatalogoPos>;
  /** Crea una cuenta abierta/comanda. SIN cobrar. Idempotente por `input.idempotencyKey`. */
  crearComanda(input: ComandaInput): Promise<ComandaResultado>;
  obtenerHistorialPorTelefono(input: { readonly telefono: string; readonly limite: number }): Promise<readonly PedidoHistorialPos[]>;
  obtenerEstadoComanda(input: { readonly sucursal: SucursalPos; readonly folio: string }): Promise<ConsultaEstadoComanda>;
  salud(): Promise<SaludPos>;
}

export class SoftRestaurantNoDisponibleError extends Error {
  readonly causa: CausaNoDisponible;
  constructor(causa: CausaNoDisponible, message?: string) {
    super(message ?? `SoftRestaurant no disponible (${causa})`);
    this.name = "SoftRestaurantNoDisponibleError";
    this.causa = causa;
  }
}

const SUCURSALES_SET: ReadonlySet<string> = new Set(SUCURSALES_POS);

export function esSucursalPos(value: unknown): value is SucursalPos {
  return typeof value === "string" && SUCURSALES_SET.has(value);
}

/**
 * Validacion pura del contrato de entrada de `crearComanda`. La usan el outbox
 * (antes de enviar: una comanda invalida se manda directo a captura manual, no se
 * reintenta) y el adaptador falso. Devuelve la lista de violaciones ([] si valida).
 */
export function validarComandaInput(input: ComandaInput): string[] {
  const errores: string[] = [];
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 200) {
    errores.push("idempotencyKey: requerida, 1 a 200 caracteres");
  }
  if (!esSucursalPos(input.sucursal)) errores.push("sucursal: debe ser T1..T8");
  if (input.tipo !== "domicilio" && input.tipo !== "recoger") errores.push("tipo: debe ser domicilio o recoger");
  if (!input.cliente || typeof input.cliente.nombre !== "string" || input.cliente.nombre.trim() === "") errores.push("cliente.nombre: requerido");
  if (!input.cliente || typeof input.cliente.telefono !== "string" || input.cliente.telefono.trim() === "") errores.push("cliente.telefono: requerido");
  if (input.tipo === "domicilio" && (!input.direccion || typeof input.direccion.texto !== "string" || input.direccion.texto.trim() === "")) {
    errores.push("direccion: requerida para domicilio");
  }
  if (input.formaPago !== "efectivo" && input.formaPago !== "tarjeta") errores.push("formaPago: debe ser efectivo o tarjeta");
  if (input.propina !== undefined) {
    if (typeof input.propina !== "number" || !Number.isFinite(input.propina) || input.propina < 0) errores.push("propina: monto >= 0");
    else if (input.propina > 0 && input.formaPago !== "tarjeta") errores.push("propina: solo se acepta con tarjeta");
  }
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
    errores.push("items: entre 1 y 100 renglones");
  } else {
    input.items.forEach((item, i) => {
      if (!item || typeof item.codigo !== "string" || item.codigo.trim() === "") errores.push(`items[${i}].codigo: requerido`);
      if (!item || !Number.isInteger(item.cantidad) || item.cantidad <= 0) errores.push(`items[${i}].cantidad: entero > 0`);
      if (!item || !Array.isArray(item.modificadores)) errores.push(`items[${i}].modificadores: arreglo requerido`);
    });
  }
  return errores;
}
