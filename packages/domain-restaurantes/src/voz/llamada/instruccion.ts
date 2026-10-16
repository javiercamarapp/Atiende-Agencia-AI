// Instruccion del agente de VOZ para UNA llamada real (la arma el servidor, no el worker): el MISMO perfil de PM que WhatsApp y que la vista
// previa (`buildPmSystemPrompt` con canal `voz`), con la hora local y la sucursal MARCADA de la llamada. La memoria del cliente ("lo de
// siempre") la trae el agente con la herramienta `buscar_cliente`, cuyo telefono sale del token de la llamada (el SIP From), nunca del modelo:
// la version compacta del perfil de voz no lleva el historial en el prompt, asi que aqui NO se consulta al cliente salvo que el dueno haya
// editado el comportamiento (`branch_voice_config.comportamiento`): ese texto manda como base y se le anexa el contexto de la llamada, con
// el cliente.
//
// Reglas duras H1-H18 no borrables (brief rescate-orig-restaurantes-1 §1, PR #411): con comportamiento editado, la instruccion final la arma
// `instruccionVozConReglas` (texto del dueno + contexto + saludo + BLOQUE de reglas al final, donde un "ignore lo anterior" ya no llega).
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../../whatsapp/perfil-pm.ts";
import { PM_CONFIG_POR_OMISION, customerContextBlock, estadoSucursalParaPrompt, resolveAgentConfig, saludoSegunHora } from "../../whatsapp/llm-turn-handler.ts";
import { resolverMarcadorSaludo } from "../saludo-marcador.ts";
import { lookupCustomerConPedidoReciente } from "../../customers.ts";
import type { RestaurantesRepository } from "../../repository.ts";
import type { CustomerLookupResult } from "../../types.ts";
import { APENDICE_VOZ, instruccionVozConReglas } from "../perfil-voz-pm.ts";
import type { VozConfig } from "../types.ts";

export interface EntradaInstruccionLlamada {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Telefono canonico del SIP From; null = llamante anonimo (se trata como cliente nuevo y sin historial). */
  readonly telefono: string | null;
  readonly config: VozConfig;
  readonly ahora: Date;
}

export interface InstruccionLlamada {
  readonly instruccion: string;
  /** Hora local (0-23) de la sucursal: elige el saludo pregrabado y la franja del KPI. */
  readonly horaLocal: number;
  readonly zonaHoraria: string;
}

function horaLocalEn(timezone: string, ahora: Date): number {
  const hora = Number(new Intl.DateTimeFormat("es-MX", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(ahora));
  return Number.isInteger(hora) && hora >= 0 && hora <= 23 ? hora : 0;
}

export async function armarInstruccionLlamada(repo: RestaurantesRepository, e: EntradaInstruccionLlamada): Promise<InstruccionLlamada> {
  const config = await resolveAgentConfig(repo, e.organizationId, e.propertyId);
  const zonaHoraria = config.timezone || PM_CONFIG_POR_OMISION.timezone;
  const editable = e.config.configurada ? e.config.comportamiento.trim() : "";
  // Secuencial a proposito: ambas consultas comparten la sesion (una sola transaccion); si alguna pasa a usar SAVEPOINT, en paralelo se entrelazarian.
  const branches = await repo.listBranchesForOrganization(e.organizationId);
  const entrada = await repo.findBranchById(e.organizationId, e.propertyId);
  // Solo el comportamiento editado necesita al cliente en el texto: sin el, no se hace una consulta de historial que el prompt no usa.
  const cliente: CustomerLookupResult = editable !== "" && e.telefono ? await lookupCustomerConPedidoReciente(repo, e.organizationId, e.telefono, e.ahora) : { isNew: true };
  const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: zonaHoraria, dateStyle: "long", timeStyle: "short", hourCycle: "h23" }).format(e.ahora);
  const dia = new Intl.DateTimeFormat("es-MX", { timeZone: zonaHoraria, weekday: "long" }).format(e.ahora);
  const saludo = saludoSegunHora(zonaHoraria, e.ahora);
  const marcada = entrada ? { name: entrada.name, slug: entrada.slug } : null;
  // VZ17 (ronda 5): a las 8:00 el agente saludaba «Buenas tardes» y pedia el nombre ANTES de saber si la sucursal estaba abierta. El saludo y el estado abierta/cerrada
  // (con el horario de la sucursal marcada) los calcula el SERVIDOR con la hora de la sucursal y viajan en la instruccion: el modelo no los adivina. Un `{saludo}` en el
  // mensaje inicial se resuelve aqui (antes se mandaba literal).
  const estadoSucursalAhora = await estadoSucursalParaPrompt(repo, entrada, e.ahora);
  const inicial = e.config.configurada ? resolverMarcadorSaludo(e.config.mensajeInicial.trim(), zonaHoraria, e.ahora) : "";
  let instruccion: string;
  if (editable === "") {
    instruccion =
      buildPmSystemPrompt({
        canal: "voz",
        businessName: config.businessName,
        agentName: config.agentName ?? PM_AGENT_NAME_POR_OMISION,
        deliveryTimeText: config.deliveryTimeText,
        saludo,
        branches,
        entryBranch: marcada,
        customer: cliente,
        fechaHoraLocal: fechaHora,
        diaSemana: dia,
        ...(estadoSucursalAhora ? { estadoSucursalAhora } : {}),
        saludoPersonalizado: config.greetingText ?? null,
        salsasTexto: config.salsasText ?? null,
        promosTexto: config.promosText ?? null,
        motivosDesactivados: config.motivosDesactivados ?? [],
        pedidoGrandeTexto: config.largeOrderText ?? null,
      }) + APENDICE_VOZ;
  } else {
    const contexto = [
      "# CONTEXTO DE ESTA LLAMADA (lo pone el sistema, no el cliente)",
      `- Fecha y hora local (${zonaHoraria}): ${fechaHora}; día de la semana: ${dia}.`,
      `- Saludo según la hora: "${saludo}". Use SOLO ese saludo (nunca otro de «buenos días», «buenas tardes» o «buenas noches»).`,
      ...(estadoSucursalAhora ? [`- ESTADO DE LA SUCURSAL AHORA (lo calcula el sistema; consúltelo ANTES de pedir el nombre): ${estadoSucursalAhora}`] : []),
      marcada ? `- El cliente llamó a la sucursal "${marcada.name}" (branch_slug: "${marcada.slug}").` : "- Esta llamada no pertenece a una sucursal en particular.",
      `- ${customerContextBlock(cliente).replace(/\n/g, "\n  ")}`,
    ].join("\n");
    instruccion = instruccionVozConReglas({
      comportamiento: `${editable}\n\n${contexto}`,
      mensajeInicial: inicial,
      businessName: config.businessName,
      agentName: config.agentName ?? PM_AGENT_NAME_POR_OMISION,
      deliveryTimeText: config.deliveryTimeText,
      promosTexto: config.promosText ?? null,
      salsasTexto: config.salsasText ?? null,
      pedidoGrandeTexto: config.largeOrderText ?? null,
      motivosDesactivados: config.motivosDesactivados ?? [],
    });
  }
  if (editable === "" && inicial !== "") instruccion += `\n\n# PRIMER MENSAJE\nAl contestar, diga exactamente: "${inicial}"`;
  return { instruccion, horaLocal: horaLocalEn(zonaHoraria, e.ahora), zonaHoraria };
}
