// PAQUETE A (PM): gancho de reconocimiento de cliente recurrente («¿lo de siempre?»). SOLO DISEÑO: sin datos reales.
// La base de clientes de PM (número + dirección) aún no llega; Javier pide que sea el PRIMER paso tras el saludo: pedir el teléfono, vincularlo,
// mostrar la dirección guardada y preguntar si es correcta; si no existe o no es correcta, registrar cliente nuevo.
// Esos datos son personales (tratamiento como ENCARGADA de PM): este módulo no los lee de ningún lado ni los guarda en el repo.
// Un integrador futuro implementa `ProveedorClientesRecurrentes` contra las tablas de las migraciones 049 y 054 y lo enlaza en registry.ts.
import { canonicalizeMexicanPhone } from "../phone.ts";
import { sinAcentos } from "../product-search.ts";

export type ClienteRecurrente = {
  readonly direccionGuardada: string | null;
  readonly ultimoPedido: { readonly items: ReadonlyArray<{ readonly nombre: string; readonly cantidad: number }> } | null;
};

export interface ProveedorClientesRecurrentes {
  buscarPorTelefono(telefono: string): Promise<ClienteRecurrente | null>;
}

/** Proveedor por omisión mientras no llegue la base: nunca devuelve a nadie. */
export const proveedorClientesSinDatos: ProveedorClientesRecurrentes = {
  async buscarPorTelefono() {
    return null;
  },
};

// Frases con contexto de pedido anterior: valen en cualquier mensaje.
const FRASES_LO_DE_SIEMPRE = [
  /\blo (?:de|del) siempre\b/,
  /\blo mismo (?:de|que) (?:siempre|la vez|mi (?:pedido|ultimo)|antes|el (?:ultimo|anterior|pedido))\b/,
  /\bigual que (?:la vez|el pedido|mi pedido|siempre)\b/,
  /\brepite(?:me)? (?:mi |el )?(?:ultimo|anterior|pedido)/,
  /\bel mismo pedido\b/,
];

/** «lo mismo» a secas es demasiado amplio («quiero lo mismo que mi amigo»): solo cuenta si el mensaje es corto (<= 6 palabras) y no nombra a un tercero. */
export function esLoDeSiempre(texto: string): boolean {
  const t = sinAcentos(texto);
  if (FRASES_LO_DE_SIEMPRE.some((r) => r.test(t))) return true;
  const palabras = t.split(/\s+/).filter(Boolean).length;
  return /\blo mismo\b/.test(t) && palabras <= 6 && !/\b(?:que|como)\b/.test(t);
}

export type PlanRecurrente = {
  readonly accion: "preguntar_telefono" | "pedir_pedido_completo" | "proponer_lo_de_siempre" | "confirmar_direccion" | "pedir_direccion_cliente_no_vinculado";
  /** true si el teléfono tecleado NO es el del remitente: no se revela nada y el personal vincula después. */
  readonly vincularPorPersonal: boolean;
  readonly registrarClienteNuevo: boolean;
  readonly recotizarConMenuVigente: boolean;
  readonly confirmarAntesDeCocina: boolean;
  readonly confirmarDireccion: string | null;
  /** Guía para el agente (sin precios, sin datos del cliente más allá de la dirección que ya se le muestra a él mismo). */
  readonly mensajeGuia: string;
};

/**
 * SEGURIDAD: `telefonoRemitente` es el número de WhatsApp que ESCRIBE (lo da el canal, no el cliente). `telefonoDicho` es el que el cliente teclea
 * en el chat. La dirección y el historial guardados SOLO se usan si ambos coinciden; si el cliente dicta otro número (el de un tercero), no se revela
 * ninguna dirección, se trata como cliente no vinculado, se pide la dirección y el personal vincula después. `cliente` debe haberse buscado con el
 * número del REMITENTE.
 */
export function planReconocimientoRecurrente(entrada: {
  readonly telefonoRemitente: string | null;
  readonly telefonoDicho?: string | null;
  readonly texto: string;
  readonly cliente: ClienteRecurrente | null;
}): PlanRecurrente {
  const vacio = { vincularPorPersonal: false, registrarClienteNuevo: false, recotizarConMenuVigente: false, confirmarAntesDeCocina: false, confirmarDireccion: null };
  const remitente = entrada.telefonoRemitente ? canonicalizeMexicanPhone(entrada.telefonoRemitente) : null;
  if (!remitente) {
    return { ...vacio, accion: "pedir_direccion_cliente_no_vinculado", vincularPorPersonal: true, mensajeGuia: "No se puede vincular el número: pida la dirección de entrega; el personal vinculará al cliente después. No muestre ninguna dirección guardada." };
  }
  if (entrada.telefonoDicho) {
    const dicho = canonicalizeMexicanPhone(entrada.telefonoDicho);
    if (dicho !== remitente) {
      return { ...vacio, accion: "pedir_direccion_cliente_no_vinculado", vincularPorPersonal: true, mensajeGuia: "El número que escribió no es el de este chat: no revele ninguna dirección ni historial. Trátelo como cliente no vinculado, pida la dirección de entrega y avise que el personal lo vinculará después." };
    }
  }
  const siempre = esLoDeSiempre(entrada.texto);
  const c = entrada.cliente;
  if (!c) {
    return {
      ...vacio,
      accion: "pedir_pedido_completo",
      registrarClienteNuevo: true,
      mensajeGuia: siempre
        ? "No tengo registrado un pedido anterior con este número; ¿me dice su pedido completo? Quedará registrado como cliente nuevo. No invente historial."
        : "Cliente nuevo: tome el pedido completo y regístrelo.",
    };
  }
  if (siempre && c.ultimoPedido && c.ultimoPedido.items.length > 0) {
    return {
      vincularPorPersonal: false,
      accion: "proponer_lo_de_siempre",
      registrarClienteNuevo: false,
      recotizarConMenuVigente: true,
      confirmarAntesDeCocina: true,
      confirmarDireccion: c.direccionGuardada,
      mensajeGuia: "Proponga el pedido anterior, recotice con el menú vigente (no con precios guardados), confirme la dirección guardada y pida el sí antes de mandar a cocina.",
    };
  }
  if (siempre) {
    return { ...vacio, accion: "pedir_pedido_completo", confirmarDireccion: c.direccionGuardada, mensajeGuia: "No hay un pedido anterior registrado; pida el pedido completo. No invente historial." };
  }
  if (!c.direccionGuardada) return { ...vacio, accion: "pedir_pedido_completo", mensajeGuia: "Cliente vinculado sin dirección guardada: pida la dirección de entrega." };
  return { ...vacio, accion: "confirmar_direccion", confirmarDireccion: c.direccionGuardada, mensajeGuia: "Muestre la dirección guardada y pregunte si es correcta; si no lo es, registre la nueva." };
}
