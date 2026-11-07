// Limpieza PURA de un renglon historico (cliente con agregados) -> `ClienteHistorico` canonico + banderas, o un rechazo con motivo.
// Reglas (spec F1): telefono a 10 digitos canonicos (nunca se recorta), sin consentimiento, sin texto libre de quejas, sin pines,
// el nombre no se inventa, la colonia se infiere con el catalogo configurable y SIEMPRE queda marcada si no vino del dato.
import { createHash } from "node:crypto";
import { canonicalizeMexicanPhone } from "../phone.ts";
import { sinAcentos } from "../product-search.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import { CATALOGO_MERIDA, inferirColoniaDeDireccion, normalizarColonia, type CatalogoColonias } from "./colonias.ts";

export const QUEJA_CATEGORIAS = ["demora", "faltante", "cobro", "salsas", "cancelado", "equivocado", "otra"] as const;
export type QuejaCategoria = (typeof QUEJA_CATEGORIAS)[number];
export type CanalHistorico = "domicilio" | "recoger";
export type PagoHistorico = "efectivo" | "tarjeta";
export type TortillaHistorica = "maiz" | "harina" | "mixta";
export type EstadoHistorico = "activo" | "dormido" | "queja_abierta" | "n/a";

export interface ClienteHistorico {
  /** Renglon de datos (1 = primero tras el encabezado). Solo para el reporte; NO entra a la huella. */
  readonly fila: number;
  readonly telefono: string;
  readonly nombre: string | null;
  readonly direccion: string | null;
  readonly colonia: string | null;
  readonly canal: CanalHistorico | null;
  readonly pago: PagoHistorico | null;
  readonly tortilla: TortillaHistorica | null;
  readonly salsas: readonly string[];
  readonly omisiones: readonly string[];
  readonly favoritos: readonly string[];
  readonly pedidos: number;
  readonly gastoMxn: number;
  readonly ticketMxn: number | null;
  readonly primerPedido: string | null;
  readonly ultimoPedido: string | null;
  readonly estado: EstadoHistorico | null;
  readonly quejas: readonly QuejaCategoria[];
  /** Telefonos (10 digitos) que el archivo marca como posible duplicado de este. */
  readonly duplicadoCon: readonly string[];
  readonly banderas: readonly string[];
  readonly huella: string;
}

export type MotivoRechazo = "fila_invalida" | "telefono_faltante" | "telefono_invalido" | "telefono_repetido_en_archivo";
export interface FilaRechazada {
  readonly fila: number;
  readonly motivo: MotivoRechazo;
  /** Telefono enmascarado (ultimos 4) cuando existe; nunca el numero completo. */
  readonly telefonoMascara: string | null;
}

export interface OpcionesLimpieza {
  readonly catalogoColonias?: CatalogoColonias;
  /** Catalogo de productos para validar favoritos (nombres canonicos). Sin catalogo, los favoritos quedan como texto libre. */
  readonly catalogoProductos?: readonly string[];
}

const MAX_NOMBRE = 120;
const MAX_DIRECCION = 300;
const MAX_ITEM = 120;
const MAX_LISTA = 12;

function texto(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  const limpio = sanitizeInlineText(s, max);
  return limpio === "" ? null : limpio;
}

function lista(v: unknown, max = MAX_LISTA): string[] {
  if (v === null || v === undefined) return [];
  const crudo = Array.isArray(v) ? v.map((x) => String(x ?? "")) : String(v).split(/[;|\n]+|,(?!\d)/);
  const out: string[] = [];
  for (const parte of crudo) {
    const t = sanitizeInlineText(parte, MAX_ITEM).toLowerCase();
    if (t !== "" && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function numero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$\s]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** AAAA-MM-DD, DD/MM/AAAA o ISO con hora -> AAAA-MM-DD valido, o null. */
export function fechaDia(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let a: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (r) [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [d, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || a < 2000 || a > 2100) return null;
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function enumerado<T extends string>(v: unknown, permitidos: readonly T[], alias: Readonly<Record<string, T>> = {}): T | null {
  const t = sinAcentos(typeof v === "string" ? v : "").trim();
  if (t === "") return null;
  if ((permitidos as readonly string[]).includes(t)) return t as T;
  return alias[t] ?? null;
}

/** Categoria de queja: SOLO la categoria, jamas el texto libre. Lo que no se reconoce se vuelve «otra». */
export function categoriaQueja(v: string): QuejaCategoria {
  const t = sinAcentos(v);
  if (/demor|tard|lent|retras/.test(t)) return "demora";
  if (/falt|incomplet/.test(t)) return "faltante";
  if (/cobr|cargo|precio|ticket/.test(t)) return "cobro";
  if (/salsa/.test(t)) return "salsas";
  if (/cancel/.test(t)) return "cancelado";
  if (/equivoc|erroneo|cambiad|distinto/.test(t)) return "equivocado";
  return "otra";
}

/** Telefono enmascarado local (sin importar phone.ts para no arrastrar mas de lo necesario). */
function mascara(tel: string | null): string | null {
  if (tel === null) return null;
  const d = tel.replace(/\D/g, "");
  return d.length < 4 ? "****" : `${"*".repeat(d.length - 4)}${d.slice(-4)}`;
}

export function huellaDeCliente(c: Omit<ClienteHistorico, "huella" | "fila">): string {
  const canon = [
    c.telefono, c.nombre, c.direccion, c.colonia, c.canal, c.pago, c.tortilla,
    [...c.salsas].sort(), [...c.omisiones].sort(), [...c.favoritos].sort(),
    c.pedidos, c.gastoMxn, c.ticketMxn, c.primerPedido, c.ultimoPedido, c.estado,
    [...c.quejas].sort(), [...c.banderas].sort(),
  ];
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Preferencias en una sola celda: `tortilla:maiz;salsa:verde;salsa:roja;omision:cebolla`. */
function preferencias(v: unknown): { tortilla: TortillaHistorica | null; salsas: string[]; omisiones: string[] } {
  let tortilla: TortillaHistorica | null = null;
  const salsas: string[] = [];
  const omisiones: string[] = [];
  for (const par of lista(v, 40)) {
    const [k, ...resto] = par.split(":");
    const val = sinAcentos(resto.join(":")).trim();
    if (val === "") continue;
    const kk = sinAcentos(k ?? "");
    if (kk === "tortilla") tortilla = enumerado(val, ["maiz", "harina", "mixta"]) ?? tortilla;
    else if (kk === "salsa" || kk === "salsas") salsas.push(val);
    else if (kk === "omision" || kk === "omisiones" || kk === "sin") omisiones.push(val);
  }
  return { tortilla, salsas: [...new Set(salsas)].slice(0, MAX_LISTA), omisiones: [...new Set(omisiones)].slice(0, MAX_LISTA) };
}

function get(r: Record<string, unknown>, ...llaves: string[]): unknown {
  for (const k of llaves) if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
  return undefined;
}

export type ResultadoLimpieza = { readonly ok: true; readonly cliente: ClienteHistorico } | { readonly ok: false; readonly rechazo: FilaRechazada };

/** Limpia UN renglon. `fila` empieza en 1. */
export function limpiarFilaHistorica(cruda: unknown, fila: number, opciones: OpcionesLimpieza = {}): ResultadoLimpieza {
  if (cruda === null || typeof cruda !== "object" || Array.isArray(cruda)) return { ok: false, rechazo: { fila, motivo: "fila_invalida", telefonoMascara: null } };
  const r = cruda as Record<string, unknown>;
  const telCrudo = texto(get(r, "celular", "telefono", "phone", "whatsapp"), 40);
  if (telCrudo === null) return { ok: false, rechazo: { fila, motivo: "telefono_faltante", telefonoMascara: null } };
  const telefono = canonicalizeMexicanPhone(telCrudo);
  if (telefono === null) return { ok: false, rechazo: { fila, motivo: "telefono_invalido", telefonoMascara: mascara(telCrudo) } };

  const catalogo = opciones.catalogoColonias ?? CATALOGO_MERIDA;
  const banderas = new Set<string>();
  for (const b of lista(get(r, "calidad_dato", "calidad"), 20)) if (/^[a-z0-9_]{1,60}$/.test(b)) banderas.add(b);

  const nombre = texto(get(r, "nombre", "name"), MAX_NOMBRE);
  if (nombre === null) banderas.add("sin_nombre");

  const canalCrudo = get(r, "entrega_habitual", "canal");
  const canal = enumerado<CanalHistorico>(canalCrudo, ["domicilio", "recoger"], { "a domicilio": "domicilio", envio: "domicilio", sucursal: "recoger", recoleccion: "recoger", pickup: "recoger" });
  const pago = enumerado<PagoHistorico>(get(r, "pago", "forma_pago"), ["efectivo", "tarjeta"], { cash: "efectivo", terminal: "tarjeta", credito: "tarjeta", debito: "tarjeta" });

  const direccion = texto(get(r, "direccion", "domicilio"), MAX_DIRECCION);
  let colonia: string | null = null;
  const coloniaCruda = texto(get(r, "colonia"), 120);
  if (coloniaCruda !== null) {
    const n = normalizarColonia(coloniaCruda, catalogo);
    colonia = n.colonia;
    if (n.metodo === "marcador_libre") banderas.add("colonia_fuera_de_catalogo");
  } else if (direccion !== null) {
    const inf = inferirColoniaDeDireccion(direccion, catalogo);
    if (inf.colonia !== null) {
      colonia = inf.colonia;
      banderas.add(inf.confianza === "alta" ? "colonia_inferida_alta" : "colonia_inferida_media");
    }
  }
  if (canal === "domicilio" && direccion === null) banderas.add("domicilio_sin_direccion");
  if (direccion !== null && colonia === null) banderas.add("colonia_pendiente_pedir_ubicacion");

  const pref = preferencias(get(r, "preferencias"));
  const tortilla = pref.tortilla ?? enumerado<TortillaHistorica>(get(r, "tortilla"), ["maiz", "harina", "mixta"]);
  const favoritos = lista(get(r, "favoritos"));
  if (opciones.catalogoProductos) {
    const norm = new Set(opciones.catalogoProductos.map((p) => sinAcentos(p).trim()));
    if (favoritos.some((f) => !norm.has(sinAcentos(f)))) banderas.add("favorito_sin_catalogo");
  }

  let pedidos = numero(get(r, "pedidos", "num_pedidos"));
  if (pedidos === null || pedidos < 0 || !Number.isInteger(pedidos)) {
    if (pedidos !== null) banderas.add("pedidos_invalido");
    pedidos = pedidos !== null && pedidos >= 0 ? Math.floor(pedidos) : 0;
  }
  let gasto = numero(get(r, "gasto_piso_mxn", "gasto_mxn", "gasto"));
  if (gasto === null || gasto < 0) {
    if (gasto !== null) banderas.add("gasto_invalido");
    gasto = 0;
  }
  let ticket = numero(get(r, "ticket_mxn", "ticket"));
  if (ticket !== null && ticket < 0) {
    banderas.add("ticket_invalido");
    ticket = null;
  }
  if (ticket === null && pedidos > 0 && gasto > 0) ticket = Math.round((gasto / pedidos) * 100) / 100;

  const primerCrudo = get(r, "primer_pedido");
  const ultimoCrudo = get(r, "ultimo_pedido");
  let primerPedido = fechaDia(primerCrudo);
  let ultimoPedido = fechaDia(ultimoCrudo);
  if ((primerCrudo !== undefined && primerPedido === null) || (ultimoCrudo !== undefined && ultimoPedido === null)) banderas.add("fecha_invalida");
  if (primerPedido !== null && ultimoPedido !== null && primerPedido > ultimoPedido) {
    banderas.add("fechas_invertidas");
    [primerPedido, ultimoPedido] = [ultimoPedido, primerPedido];
  }

  const estado = enumerado<EstadoHistorico>(get(r, "estado"), ["activo", "dormido", "queja_abierta", "n/a"]);
  if (estado === "queja_abierta") banderas.add("revision_humana");

  const quejas = [...new Set(lista(get(r, "quejas"), 20).map(categoriaQueja))].sort() as QuejaCategoria[];

  const duplicadoCon = lista(get(r, "duplicado_con"), 10)
    .map((t) => canonicalizeMexicanPhone(t))
    .filter((t): t is string => t !== null && t !== telefono);
  if (duplicadoCon.length > 0) banderas.add("posible_duplicado");

  const base = {
    telefono, nombre, direccion, colonia, canal, pago, tortilla,
    salsas: pref.salsas, omisiones: pref.omisiones, favoritos,
    pedidos, gastoMxn: gasto, ticketMxn: ticket, primerPedido, ultimoPedido, estado, quejas,
    duplicadoCon: [...new Set(duplicadoCon)].sort(),
    banderas: [...banderas].sort(),
  };
  return { ok: true, cliente: { fila, ...base, huella: huellaDeCliente(base) } };
}

/** Limpia todos los renglones; el segundo renglon con el mismo telefono se rechaza (el primero gana; queda en el reporte). */
export function limpiarArchivoHistorico(crudas: readonly unknown[], opciones: OpcionesLimpieza = {}): { clientes: ClienteHistorico[]; rechazos: FilaRechazada[] } {
  const clientes: ClienteHistorico[] = [];
  const rechazos: FilaRechazada[] = [];
  const vistos = new Set<string>();
  crudas.forEach((cruda, i) => {
    const res = limpiarFilaHistorica(cruda, i + 1, opciones);
    if (!res.ok) {
      rechazos.push(res.rechazo);
      return;
    }
    if (vistos.has(res.cliente.telefono)) {
      rechazos.push({ fila: i + 1, motivo: "telefono_repetido_en_archivo", telefonoMascara: mascara(res.cliente.telefono) });
      return;
    }
    vistos.add(res.cliente.telefono);
    clientes.push(res.cliente);
  });
  return { clientes, rechazos };
}
