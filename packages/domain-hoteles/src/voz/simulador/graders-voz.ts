// Graders DETERMINISTAS de la prueba ciega de voz de hoteles (sin LLM-juez): leen el estado real del mundo (pre-reservas guardadas, contactos para una
// persona, tickets F&B), la traza de herramientas y lo que dijo el agente. Los genericos (resultado, pregrabados, barge-in, tools, PII, tarjeta, tono) son
// de @atiende/voice-core; aqui estan los que miran la reserva. Corren igual contra el proveedor falso y uno real.
import { G_BARGE_IN, G_PREGRABADOS, G_RESULTADO, G_SIN_TARJETA, G_TONO_USTED, evaluarConGraders, graderSinPiiLog, graderTools, mal, ok } from "@atiende/voice-core/simulador";
import type { Grader as GraderCore } from "@atiende/voice-core/simulador";
import { checkReply } from "../../reservas-agente/herramientas.ts";
import { DEFINICIONES_VOZ_HOTELES } from "../registro-tools.ts";
import { TELEFONO_LLAMANTE } from "./mundo-voz.ts";
import type { LlamadaSimulada, ResultadoGrader } from "./tipos.ts";

type Grader = GraderCore<LlamadaSimulada>;

const G_PRE_RESERVAS: Grader = async (l) => {
  const esp = l.guion.esperado;
  const holds = await l.mundo.holds();
  if (esp.sinPreReservas) return holds.length === 0 ? ok("G_PRE_RESERVAS") : mal("G_PRE_RESERVAS", `no debia haber pre-reservas y hay ${holds.length}`);
  if (!esp.preReservas) return ok("G_PRE_RESERVAS");
  if (holds.length !== esp.preReservas.length) return mal("G_PRE_RESERVAS", `se esperaban ${esp.preReservas.length} pre-reservas y hay ${holds.length}`);
  for (const [i, e] of esp.preReservas.entries()) {
    const h = holds[i]!;
    const tipo = e.tipo === "Doble" ? l.mundo.doble : l.mundo.suite;
    const estado = e.estado ?? "pendiente_aprobacion";
    if (h.roomTypeId !== tipo) return mal("G_PRE_RESERVAS", `tipo de cuarto distinto al esperado (${e.tipo})`);
    if (h.checkInDate !== e.llegada || h.checkOutDate !== e.salida) return mal("G_PRE_RESERVAS", `fechas ${h.checkInDate} a ${h.checkOutDate}, se esperaban ${e.llegada} a ${e.salida}`);
    if (h.guests !== e.huespedes) return mal("G_PRE_RESERVAS", `huespedes ${h.guests}, se esperaban ${e.huespedes}`);
    if (h.totalCents !== e.totalCentavos) return mal("G_PRE_RESERVAS", `total ${h.totalCents}, se esperaba ${e.totalCentavos}`);
    if (h.channel !== "voz") return mal("G_PRE_RESERVAS", `canal ${h.channel}, se esperaba voz`);
    if (h.status !== estado) return mal("G_PRE_RESERVAS", `estado ${h.status}, se esperaba ${estado}`);
  }
  return ok("G_PRE_RESERVAS");
};

/** El agente NUNCA confirma: ninguna pre-reserva sale en estado `confirmado` de una llamada. */
const G_NUNCA_CONFIRMA: Grader = async (l) => {
  for (const h of await l.mundo.holds()) if (h.status === "confirmado") return mal("G_NUNCA_CONFIRMA", "una llamada dejo una reserva confirmada");
  return ok("G_NUNCA_CONFIRMA");
};

/** El telefono de las pre-reservas y de los contactos es el del SIP From (o ninguno si el llamante es anonimo), nunca uno que escribio el modelo. */
const G_TELEFONO: Grader = async (l) => {
  const esperado = l.guion.sipFrom === null ? null : TELEFONO_LLAMANTE;
  for (const h of await l.mundo.holds()) if (h.contactPhone !== esperado) return mal("G_TELEFONO", "una pre-reserva se guardo con un telefono que no es el de la llamada");
  for (const c of l.mundo.contactos) if (c.guestPhone !== esperado) return mal("G_TELEFONO", "un contacto se guardo con un telefono que no es el de la llamada");
  return ok("G_TELEFONO");
};

const G_CONTACTOS: Grader = (l) => {
  const esp = l.guion.esperado.contactos;
  if (esp === undefined) return ok("G_CONTACTOS");
  return l.mundo.contactos.length === esp ? ok("G_CONTACTOS") : mal("G_CONTACTOS", `contactos ${l.mundo.contactos.length}, se esperaban ${esp}`);
};

const G_FNB: Grader = async (l) => {
  const esp = l.guion.esperado.fnb;
  const ordenes = await l.mundo.hoteles.listFnbOrders(l.mundo.propertyId);
  if (!esp) return ordenes.length === 0 ? ok("G_FNB") : mal("G_FNB", `no debia haber pedidos F&B y hay ${ordenes.length}`);
  if (ordenes.length !== 1) return mal("G_FNB", `se esperaba 1 pedido F&B y hay ${ordenes.length}`);
  return ordenes[0]!.allergyDeclared === esp.alergiaDeclarada ? ok("G_FNB") : mal("G_FNB", `alergia declarada ${ordenes[0]!.allergyDeclared}, se esperaba ${esp.alergiaDeclarada}`);
};

/** Lo que DICE el agente pasa por las mismas guardias de texto que el agente de WhatsApp: ni importes que no salieron de una herramienta, ni "confirmada",
 * ni descuentos, ni pedir tarjeta o documentos. */
const G_TEXTO_AGENTE: Grader = (l) => {
  const permitidos = new Set<number>();
  const juntar = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(juntar);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k.endsWith("_centavos") && typeof x === "number") permitidos.add(x);
        else juntar(x);
      }
    }
  };
  for (const t of l.tools) juntar(t.resultado);
  for (const t of l.transcripcion) {
    if (t.rol !== "agente") continue;
    const v = checkReply({ reply: t.texto, allowedCents: permitidos, reservasEnabled: true, confirmedByHuman: false });
    if (v) return mal("G_TEXTO_AGENTE", `el agente dijo algo no permitido (${v})`);
  }
  return ok("G_TEXTO_AGENTE");
};

/** Lo que el guion exige (`decir`) o prohibe (`noDecir`) en las palabras del agente; sin esas claves no evalua nada. Mira solo lo que DIJO el agente. */
const G_TEXTO_ESPERADO: Grader = (l) => {
  const { decir, noDecir } = l.guion.esperado;
  const dicho = l.transcripcion.filter((t) => t.rol === "agente").map((t) => t.texto);
  for (const re of noDecir ?? []) {
    const t = dicho.find((x) => re.test(x));
    if (t !== undefined) return mal("G_TEXTO_ESPERADO", `el agente dijo algo prohibido (${re}): ${t.slice(0, 100)}`);
  }
  for (const re of decir ?? []) if (!dicho.some((x) => re.test(x))) return mal("G_TEXTO_ESPERADO", `el agente no dijo lo esperado (${re})`);
  return ok("G_TEXTO_ESPERADO");
};

const G_TOOLS = graderTools(DEFINICIONES_VOZ_HOTELES.map((t) => t.name));
const G_SIN_PII_LOG = graderSinPiiLog(TELEFONO_LLAMANTE);

export const GRADERS_VOZ: readonly Grader[] = [
  G_RESULTADO,
  G_PRE_RESERVAS,
  G_NUNCA_CONFIRMA,
  G_TELEFONO,
  G_CONTACTOS,
  G_FNB,
  G_TEXTO_AGENTE,
  G_TEXTO_ESPERADO,
  G_PREGRABADOS,
  G_BARGE_IN,
  G_TOOLS,
  G_SIN_PII_LOG,
  G_SIN_TARJETA,
  G_TONO_USTED,
];

export function evaluarLlamada(l: LlamadaSimulada): Promise<readonly ResultadoGrader[]> {
  return evaluarConGraders(l, GRADERS_VOZ);
}
