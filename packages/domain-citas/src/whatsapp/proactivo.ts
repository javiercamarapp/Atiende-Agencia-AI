// PL-31: decision de canal para un aviso PROACTIVO de WhatsApp (el negocio escribe primero: recordatorio de 24 h, oferta de lista
// de espera). La politica de Meta solo entrega fuera de la ventana de 24 h una plantilla HSM aprobada. Esta pieza decide, ANTES de
// encolar, entre tres caminos y nunca finge un envio:
//   1. el cliente escribio hace menos de 23 h -> texto libre (con botones); 1 h de margen para la demora del despachador.
//   2. fuera de la ventana y la organizacion tiene la plantilla del evento APROBADA en su catalogo (core.whatsapp_plantilla) ->
//      se encola con `template` (evento + variables en el orden que declara la plantilla).
//   3. fuera de la ventana y sin plantilla aprobada -> `sin_plantilla`: NO se encola WhatsApp (Meta lo rechazaria y quedaria `dead`);
//      el llamador usa el correo si hay y deja el estado honesto.
// BASE SIN MIGRAR (0050): el repositorio devuelve `undefined` ("no se puede saber") y se conserva el comportamiento anterior.
import { correoListaEsperaCupo } from "../emails/appointment-templates.ts";
import { normalizePhone } from "../appointments.ts";
import type { CitasRepository } from "../repository.ts";

/** Ventana de servicio de Meta (24 h) menos 1 h de margen. */
export const VENTANA_SEGURA_MS = 23 * 60 * 60 * 1000;
const MAX_PARAMS = 10;
const MAX_PARAM_LENGTH = 1024;

/** Plantilla APROBADA de una organizacion para un evento (fila de core.whatsapp_plantilla). */
export interface PlantillaWhatsappAprobada {
  readonly name: string;
  readonly language: string;
  /** Nombres de las variables, en el orden de {{1}}, {{2}}... del cuerpo aprobado en Meta. */
  readonly variables: readonly string[];
}

/** Misma forma que `OutboundTemplate` de @atiende/whatsapp-gateway (se escribe tal cual en el payload del outbox). */
export interface PlantillaParaEncolar {
  readonly name: string;
  readonly language: string;
  readonly params: readonly string[];
}

type Valores = Readonly<Record<string, string>>;

export type DecisionProactivo = { readonly canal: "whatsapp"; readonly template?: PlantillaParaEncolar } | { readonly canal: "sin_plantilla" };

/**
 * Formatos con que el MISMO telefono puede estar en el ledger de entradas (`citas.whatsapp_inbound_events.phone_hash` = sha256 del
 * telefono tal como el webhook lo recibio: "+" + wa_id de Meta, p. ej. +5219981110001 o +529981110001) frente a como lo guarda
 * `citas.customers` (los ULTIMOS 10 DIGITOS, ver `normalizePhone`). Se prueban todos para no declarar "fuera de la ventana" a quien
 * acaba de escribir. Las variantes +52/+521 se agregan SOLO si el telefono es mexicano segun `normalizePhone` (llave de 10 digitos): un
 * numero de otro pais (p. ej. 15512345678) comparte sus ultimos 10 digitos con un movil mexicano y no debe heredar su ventana de 24 h
 * (Meta rechazaria el mensaje libre).
 */
export function variantesTelefonoEntrante(phone: string): readonly string[] {
  const digitos = phone.replace(/\D/gu, "");
  const ultimos10 = digitos.slice(-10);
  const variantes = [phone.trim(), digitos, `+${digitos}`];
  const esMexicano = normalizePhone(phone).replace(/\D/gu, "").length <= 10;
  if (esMexicano && ultimos10.length === 10) variantes.push(`+52${ultimos10}`, `+521${ultimos10}`, `52${ultimos10}`, `521${ultimos10}`, ultimos10);
  return [...new Set(variantes.filter((v) => v.length > 0))];
}

/** Ordena los valores segun las variables de la plantilla. `null` si falta alguno o queda vacio (Meta rechaza variables vacias). */
export function armarParametrosPlantilla(variables: readonly string[], valores: Readonly<Record<string, string>>): readonly string[] | null {
  if (variables.length > MAX_PARAMS) return null;
  const params: string[] = [];
  for (const nombre of variables) {
    const crudo = valores[nombre];
    if (typeof crudo !== "string") return null;
    const limpio = crudo.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim().slice(0, MAX_PARAM_LENGTH);
    if (limpio === "") return null;
    params.push(limpio);
  }
  return params;
}

export async function decidirEnvioProactivo(
  repo: CitasRepository,
  input: { readonly organizationId: string; readonly phone: string; readonly evento: string; readonly valores: Valores | (() => Promise<Valores>); readonly now: Date },
): Promise<DecisionProactivo> {
  const ultimo = await repo.lastInboundWhatsappAt(input.organizationId, input.phone);
  if (ultimo === undefined) return { canal: "whatsapp" }; // base sin la migracion 0050: comportamiento anterior
  const hace = input.now.getTime() - Date.parse(ultimo ?? "");
  if (ultimo !== null && Number.isFinite(hace) && hace < VENTANA_SEGURA_MS) return { canal: "whatsapp" };

  const plantilla = await repo.resolveWhatsappTemplate(input.organizationId, input.evento);
  if (!plantilla) return { canal: "sin_plantilla" };
  // Los valores se calculan solo si hay plantilla que llenar: dentro de la ventana o sin plantilla no cuestan consultas.
  const params = armarParametrosPlantilla(plantilla.variables, typeof input.valores === "function" ? await input.valores() : input.valores);
  if (!params) return { canal: "sin_plantilla" };
  return { canal: "whatsapp", template: { name: plantilla.name, language: plantilla.language, params } };
}

/**
 * Respaldo por correo de un aviso de lista de espera cuyo WhatsApp no puede salir. `false` si el cliente no dejo correo (no se encola nada).
 * El correo es un aviso PROACTIVO: no lleva la marca transaccional, asi que la lista de supresion de plataforma lo alcanza.
 */
export async function encolarCorreoListaEspera(repo: CitasRepository, input: { readonly organizationId: string; readonly phone: string; readonly evento: string; readonly dedupeKey: string }): Promise<boolean> {
  const cliente = await repo.findCustomerByPhone(input.organizationId, input.phone);
  if (!cliente?.email) return false;
  const organizacion = await repo.findOrganizationById(input.organizationId);
  const correo = correoListaEsperaCupo({ clienteNombre: cliente.fullName ?? "Cliente", tenantNombre: organizacion?.name ?? "nuestro negocio" });
  await repo.enqueueMessagingOutbox(input.organizationId, "email", input.evento, input.dedupeKey, { to: cliente.email, subject: correo.asunto, html: correo.html, text: correo.texto });
  return true;
}
