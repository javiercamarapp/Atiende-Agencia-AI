// Lo que HACE cada herramienta de voz de citas en el servidor, en UN solo lugar: lo usan las rutas HTTP del worker (`apps/api/.../citas/voice-tools.ts`,
// que ponen la autenticacion, el rate limit y el limite de cuerpo) y el transporte EN PROCESO del simulador. Asi la prueba ciega ejercita la misma
// logica que produccion.
//
// Las 9 herramientas de agenda son LAS MISMAS que las del agente de WhatsApp (`whatsapp/llm-turn-handler.ts::executeToolCall`, mismas funciones de
// dominio: `queryAvailability`, `createAppointment`, `cancelAppointment`...): una sola logica, dos canales; solo cambia el origen de la cita
// (`voice`). La novena, `derivar_a_humano`, es exclusiva de la voz: una llamada no tiene la bandeja de conversaciones de WhatsApp.
import { randomUUID } from "node:crypto";
import { registrarEscalacionCrisis } from "../crisis-guardrail.ts";
import type { HandoffAgentGate } from "../conversaciones/repository.ts";
import type { CitasRepository } from "../repository.ts";
import { CRISIS_KEYWORDS, crisisGuardActivaPara } from "../vertical-config.ts";
import { executeToolCall } from "../whatsapp/llm-turn-handler.ts";
import { MOTIVO_CRISIS_VOZ, PREFIJO_PALABRA_CLAVE } from "./guardia-crisis.ts";

export const TOOLS_VOZ_CITAS = [
  "listar_servicios",
  "listar_proveedores",
  "consultar_disponibilidad",
  "crear_cita",
  "buscar_mis_citas",
  "cancelar_cita",
  "reagendar_cita",
  "modificar_cita",
  "anotar_lista_espera",
  "derivar_a_humano",
] as const;
export type ToolVozCitas = (typeof TOOLS_VOZ_CITAS)[number];

export function esToolVozCitas(nombre: string): nombre is ToolVozCitas {
  return (TOOLS_VOZ_CITAS as readonly string[]).includes(nombre);
}

/** Ruta HTTP (relativa a `/v1/citas/:orgSlug/voz`) de cada herramienta: el manifiesto que comparten el worker y la API. */
export function rutaToolVozCitas(nombre: ToolVozCitas): string {
  return `/${nombre}`;
}

/** El cuerpo de una herramienta no cumple su contrato (la ruta responde 400; el transporte en proceso, un `error` para el modelo). */
export class VozToolValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VozToolValidacionError";
  }
}

export interface CitasVozContexto {
  readonly repo: CitasRepository;
  readonly organizationId: string;
  /** Numero de la llamada (del SIP From, ya canonico); cadena vacia = llamante anonimo (solo consultas). */
  readonly telefono: string;
  /** Id de la llamada: dedupe del aviso de callback. */
  readonly llamadaId?: string;
  /** Puerto de handoff de WhatsApp (solo lo usa la crisis; en voz no hay conversacion y devuelve null). */
  readonly handoffGate?: HandoffAgentGate;
}

const REQUIEREN_TELEFONO: ReadonlySet<string> = new Set(["buscar_mis_citas", "crear_cita", "cancelar_cita", "reagendar_cita", "modificar_cita", "anotar_lista_espera"]);

export interface ResultadoDerivacion {
  readonly ok: true;
  readonly derivado: true;
  /** El equipo recibio un aviso (WhatsApp al telefono de avisos del negocio). false = nadie configurado: el agente no debe prometer un callback. */
  readonly aviso_enviado: boolean;
  readonly crisis: boolean;
  readonly mensaje: string;
}

function limpiar(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
}

/** derivar_a_humano: deja constancia para una persona. Una CRISIS (motivo fijo `crisis`, solo en rubros de salud) registra la escalacion real
 * (`citas.emergency_escalations`, canal voz: notificacion critica + aviso al dueño); cualquier otro motivo avisa al equipo si hay telefono de avisos.
 * Nunca guarda la transcripcion. */
export async function derivarAHumanoVoz(ctx: CitasVozContexto, entrada: { readonly motivo: unknown; readonly resumen: unknown }): Promise<ResultadoDerivacion> {
  const motivo = limpiar(entrada.motivo, 500);
  if (!motivo) throw new VozToolValidacionError("motivo es requerido (máximo 500 caracteres).");
  const resumen = limpiar(entrada.resumen, 1000);
  const telefono = ctx.telefono || "anonimo";
  const tenant = await ctx.repo.findTenantConfig(ctx.organizationId);

  if (motivo === MOTIVO_CRISIS_VOZ && crisisGuardActivaPara(tenant?.rubro)) {
    // Solo una palabra de la lista FIJA (la que puso la guardia determinista) llega a la base y al aviso del dueño: el texto libre que mande el
    // modelo (o lo que haya dicho el cliente) se descarta y se guarda el texto fijo.
    const candidata = resumen.startsWith(PREFIJO_PALABRA_CLAVE) ? resumen.slice(PREFIJO_PALABRA_CLAVE.length).trim() : "";
    const palabra = CRISIS_KEYWORDS.includes(candidata) ? candidata : "";
    await registrarEscalacionCrisis(
      ctx.repo,
      ctx.organizationId,
      tenant?.ownerNotificationPhone ?? null,
      { customerPhone: telefono, channel: "voice", keyword: palabra || "señal de crisis en la llamada", excerpt: "" },
      ctx.handoffGate,
    );
    return { ok: true, derivado: true, aviso_enviado: (tenant?.ownerNotificationPhone ?? null) !== null, crisis: true, mensaje: "Una persona del equipo se pondrá en contacto." };
  }

  let avisoEnviado = false;
  if (tenant?.ownerNotificationPhone) {
    const phoneNumberId = await ctx.repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(ctx.organizationId);
    if (phoneNumberId) {
      const llamadaId = ctx.llamadaId && ctx.llamadaId.trim() ? ctx.llamadaId.trim().slice(0, 64) : randomUUID();
      await ctx.repo.enqueueMessagingOutbox(ctx.organizationId, "whatsapp", "voz.callback", `voz-callback:${llamadaId}`, {
        to: tenant.ownerNotificationPhone,
        phone_number_id: phoneNumberId,
        body: `📞 Una llamada necesita que una persona la atienda.\nCliente: ${telefono}\nMotivo: ${motivo.slice(0, 200)}${resumen ? `\nResumen: ${resumen.slice(0, 300)}` : ""}`,
      });
      avisoEnviado = true;
    }
  }
  return {
    ok: true,
    derivado: true,
    aviso_enviado: avisoEnviado,
    crisis: false,
    mensaje: avisoEnviado ? "Avisamos al equipo: una persona le devolverá la llamada." : "No hay un aviso automático configurado: pida al cliente que vuelva a llamar en horario de atención.",
  };
}

/** Despacho EN PROCESO de cualquiera de las 10 herramientas (simulador y pruebas; en produccion el worker usa las rutas HTTP, que llaman a lo mismo). */
export async function ejecutarToolVozCitas(ctx: CitasVozContexto, nombre: string, args: Readonly<Record<string, unknown>>): Promise<{ resultado: unknown; entidadId: string | null }> {
  if (!esToolVozCitas(nombre)) return { resultado: { error: `Herramienta desconocida: ${nombre}` }, entidadId: null };
  try {
    if (nombre === "derivar_a_humano") {
      return { resultado: await derivarAHumanoVoz(ctx, { motivo: args.motivo, resumen: args.resumen }), entidadId: null };
    }
    if (REQUIEREN_TELEFONO.has(nombre) && !ctx.telefono) {
      return { resultado: { error: "llamante_anonimo", mensaje: "No se pudo identificar el número de la llamada: esta acción no está disponible. Una persona del negocio continuará.", requiere_humano: true }, entidadId: null };
    }
    const salida = await executeToolCall(ctx.repo, { organizationId: ctx.organizationId, phone: ctx.telefono, name: nombre, input: { ...args }, canal: "voice" });
    const r = salida.result;
    // Las listas salen con nombre (nunca un arreglo suelto): el JSON de la ruta es un objeto y la maquina de la cita lee `servicios` / `proveedores`.
    if (nombre === "listar_servicios" && Array.isArray(r)) return { resultado: { servicios: r }, entidadId: null };
    if (nombre === "listar_proveedores" && Array.isArray(r)) return { resultado: { proveedores: r }, entidadId: null };
    const conError = typeof r === "object" && r !== null && "error" in r;
    return { resultado: r, entidadId: conError ? null : salida.appointmentId };
  } catch (err) {
    if (err instanceof VozToolValidacionError) return { resultado: { error: err.message }, entidadId: null };
    throw err;
  }
}
