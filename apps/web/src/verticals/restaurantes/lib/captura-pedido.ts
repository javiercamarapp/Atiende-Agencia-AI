// Captura de pedidos por personal (llamada, mostrador, WhatsApp manual): reglas puras del formulario del encargado. PLAN-PANEL-OPERADOR §2.1 y §5.4-B.
// El total NUNCA se calcula aqui: lo calcula el servidor con `cotizar`. Esto solo normaliza el telefono, valida lo que falta y arma el cuerpo del contrato.
import type { CanalCaptura, CanalPedidoOperacion, CotizarPedidoOperadorEntrada, CrearPedidoOperadorEntrada, FormaPagoOperacion, ViaConsentimiento } from "@atiende/domain-restaurantes/operacion";
import { etiquetasTraducidas, traductorActivo } from "@atiende/ui";
import { restaurantesCaptura } from "@atiende/ui/i18n/restaurantes/captura";

const tr = traductorActivo(restaurantesCaptura);

/** Guion que el encargado LEE al cliente antes de marcar la respuesta (texto acordado; no se parafrasea). Es lo que oye el cliente final: siempre en
 *  espanol, aunque la consola este en ingles (i18n). */
// i18n-ignorar
export const GUION_CONSENTIMIENTO = "Le mandamos el aviso de su pedido por WhatsApp a este número, ¿está bien?";

export const VIA_POR_CANAL_CAPTURA: Readonly<Record<CanalCaptura, ViaConsentimiento>> = { llamada: "verbal_llamada", mostrador: "mostrador", whatsapp_manual: "mensaje_cliente" };

/** Etiqueta en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre. */
export const ETIQUETA_CANAL_CAPTURA: Readonly<Record<CanalCaptura, string>> = etiquetasTraducidas<CanalCaptura>(
  ["llamada", "mostrador", "whatsapp_manual"],
  (c) => `restaurantes.captura.canal.${c}` as const,
  restaurantesCaptura,
);

/** Telefono mexicano a E.164 (`+52` + 10 digitos). Acepta espacios, guiones, parentesis, `+52`, `52` y el `521` antiguo. `null` si no es valido. */
export function normalizarTelefono(crudo: string): string | null {
  const d = crudo.replace(/\D/g, "");
  if (d.length === 10) return `+52${d}`;
  if (d.length === 12 && d.startsWith("52")) return `+${d}`;
  if (d.length === 13 && d.startsWith("521")) return `+52${d.slice(3)}`;
  return null;
}

export interface LineaCaptura {
  readonly productId: string;
  readonly nombre: string;
  readonly cantidad: number;
  readonly tortilla: "maiz" | "harina" | null;
  readonly nota: string;
}

export interface FormularioCaptura {
  readonly propertyId: string;
  readonly canalCaptura: CanalCaptura;
  readonly canal: CanalPedidoOperacion;
  readonly telefono: string;
  readonly nombre: string;
  readonly direccion: string;
  readonly colonia: string;
  readonly indicaciones: string;
  readonly lineas: readonly LineaCaptura[];
  readonly forma: FormaPagoOperacion;
  readonly pagaCon: string;
  /** `null` = aun no preguntado: el formulario NO se puede guardar hasta responder Si o No (nunca hay valor por omision). */
  readonly consentimiento: boolean | null;
  readonly confirmarYa: boolean;
  readonly forzarDuplicado: boolean;
}

export function formularioVacio(propertyId: string): FormularioCaptura {
  return { propertyId, canalCaptura: "llamada", canal: "domicilio", telefono: "", nombre: "", direccion: "", colonia: "", indicaciones: "", lineas: [], forma: "efectivo", pagaCon: "", consentimiento: null, confirmarYa: true, forzarDuplicado: false };
}

function modificadores(l: LineaCaptura): string[] | undefined {
  return l.tortilla ? [l.tortilla === "maiz" ? "tortilla_maiz" : "tortilla_harina"] : undefined;
}

function itemsDe(f: FormularioCaptura): CotizarPedidoOperadorEntrada["items"] {
  return f.lineas.map((l) => ({ productId: l.productId, cantidad: l.cantidad, ...(modificadores(l) ? { modificadores: modificadores(l) } : {}), ...(l.nota.trim() ? { nota: l.nota.trim() } : {}) }));
}

/** Lo necesario para pedir una cotizacion al servidor; `null` mientras falte telefono, nombre, productos o (a domicilio) direccion. */
export function entradaCotizar(f: FormularioCaptura): CotizarPedidoOperadorEntrada | null {
  const telefono = normalizarTelefono(f.telefono);
  if (!telefono || f.nombre.trim().length === 0 || f.lineas.length === 0) return null;
  if (f.canal === "domicilio" && f.direccion.trim().length < 3) return null;
  return {
    propertyId: f.propertyId,
    canalCaptura: f.canalCaptura,
    canal: f.canal,
    cliente: { telefono, nombre: f.nombre.trim() },
    direccion: f.canal === "domicilio" ? { texto: f.direccion.trim(), ...(f.colonia.trim() ? { colonia: f.colonia.trim() } : {}) } : null,
    indicacionesEntrega: f.indicaciones.trim() || null,
    items: itemsDe(f),
  };
}

/** Lo que falta para poder guardar, en lenguaje de mostrador (vacio = listo). El consentimiento es obligatorio y explicito. */
export function faltantes(f: FormularioCaptura, total: number | null, dentroDeCobertura: boolean | null): readonly string[] {
  const falta: string[] = [];
  if (!normalizarTelefono(f.telefono)) falta.push(tr("restaurantes.captura.falta.telefono"));
  if (f.nombre.trim().length === 0) falta.push(tr("restaurantes.captura.falta.nombre"));
  if (f.canal === "domicilio" && f.direccion.trim().length < 3) falta.push(tr("restaurantes.captura.falta.direccion"));
  if (f.lineas.length === 0) falta.push(tr("restaurantes.captura.falta.producto"));
  if (f.canal === "domicilio" && dentroDeCobertura === false) falta.push(tr("restaurantes.captura.falta.cobertura"));
  if (total === null && f.lineas.length > 0) falta.push(tr("restaurantes.captura.falta.total"));
  if (f.forma === "efectivo" && f.pagaCon.trim() !== "") {
    const monto = Number(f.pagaCon.replace(/,/g, ""));
    if (!Number.isFinite(monto) || monto < 0) falta.push(tr("restaurantes.captura.falta.montoValido"));
    else if (total !== null && monto < total) falta.push(tr("restaurantes.captura.falta.noCubre"));
  }
  if (f.consentimiento === null) falta.push(tr("restaurantes.captura.falta.consentimiento"));
  return falta;
}

/** Cuerpo de `POST admin/orders`; `null` si falta algo (usa `faltantes` para decir que). */
export function entradaCrear(f: FormularioCaptura): CrearPedidoOperadorEntrada | null {
  const base = entradaCotizar(f);
  if (!base || f.consentimiento === null) return null;
  const pagaCon = f.forma === "efectivo" && f.pagaCon.trim() !== "" ? Number(f.pagaCon.replace(/,/g, "")) : null;
  return {
    ...base,
    confirmarYa: f.confirmarYa,
    pago: { forma: f.forma, ...(pagaCon !== null ? { pagaCon } : {}) },
    consentimientoWhatsapp: { otorgado: f.consentimiento, via: VIA_POR_CANAL_CAPTURA[f.canalCaptura] },
    ...(f.forzarDuplicado ? { forzarDuplicado: true } : {}),
  };
}

const MOTIVOS_SIN_AVISO: Readonly<Record<string, string>> = etiquetasTraducidas(
  ["sin_consentimiento", "sin_telefono", "sin_canal_whatsapp", "plantilla_no_aprobada", "consentimiento_no_disponible", "baja_whatsapp"] as const,
  (m) => `restaurantes.captura.aviso.motivo.${m}` as const,
  restaurantesCaptura,
);

/** Texto del aviso resultante para el toast/tarjeta de confirmacion. */
export function textoAviso(aviso: { readonly estado: "encolado" | "omitido"; readonly motivo: string | null }): string {
  if (aviso.estado === "encolado") return tr("restaurantes.captura.aviso.encolado");
  return tr("restaurantes.captura.aviso.omitido", { motivo: (aviso.motivo && Object.hasOwn(MOTIVOS_SIN_AVISO, aviso.motivo) && MOTIVOS_SIN_AVISO[aviso.motivo]) || tr("restaurantes.captura.aviso.motivo.otro") });
}
