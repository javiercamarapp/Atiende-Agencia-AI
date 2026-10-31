// Envio al cliente FUERA de la ventana de 24 h (PM PR-7): solo con plantilla APROBADA; sin plantilla NO se envia nada y se avisa en el panel con el motivo.
// Dentro de la ventana sale el texto libre de siempre. La decision es pura (el reloj entra como argumento) y el envio solo ENCOLA en el outbox (nunca llama a Meta).
// La plantilla es un dato del dueno: fila de `core.whatsapp_plantilla` (vertical `restaurantes`, evento `restaurantes.respuesta_fuera_ventana`, estado aprobada).
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { toWhatsAppRecipient } from "../phone.ts";
import type { AlertasOutboxPort } from "../alertas-whatsapp/tipos.ts";

export const EVENTO_PLANTILLA_FUERA_VENTANA = "restaurantes.respuesta_fuera_ventana";
/** 24 h de Meta menos 5 minutos de margen (reloj distinto, entrega en cola): ante la duda se trata como fuera de ventana. */
export const VENTANA_CLIENTE_MS = 24 * 3_600_000 - 5 * 60_000;
export const PARAM_TEXTO_MAX = 600;

export interface PlantillaFueraVentana {
  readonly nombre: string;
  readonly idioma: string;
  readonly aprobada: boolean;
}

export type MotivoBloqueoEnvio = "sin_plantilla" | "plantilla_no_aprobada" | "telefono_invalido";

export type DecisionEnvioCliente =
  | { readonly modo: "texto" }
  | { readonly modo: "plantilla"; readonly plantilla: PlantillaFueraVentana }
  | { readonly modo: "bloqueado"; readonly motivo: MotivoBloqueoEnvio };

/** Pura. `ultimoMensajeClienteAt` desconocido (null) cuenta como FUERA de ventana: nunca se asume una ventana abierta que no se pudo comprobar. */
export function decidirEnvioAlCliente(input: { readonly ultimoMensajeClienteAt: Date | null; readonly ahora: Date; readonly plantilla: PlantillaFueraVentana | null }): DecisionEnvioCliente {
  const { ultimoMensajeClienteAt: u, ahora, plantilla } = input;
  if (u !== null && ahora.getTime() - u.getTime() < VENTANA_CLIENTE_MS && ahora.getTime() >= u.getTime() - 60_000) return { modo: "texto" };
  if (plantilla === null) return { modo: "bloqueado", motivo: "sin_plantilla" };
  if (!plantilla.aprobada) return { modo: "bloqueado", motivo: "plantilla_no_aprobada" };
  return { modo: "plantilla", plantilla };
}

export interface PlantillasFueraVentanaPort {
  resolver(organizationId: string): Promise<PlantillaFueraVentana | null>;
}

export interface AvisoEnvioBloqueadoPort {
  bloqueado(input: { readonly organizationId: string; readonly propertyId: string; readonly conversationId: string; readonly motivo: MotivoBloqueoEnvio }): Promise<void>;
}

export interface EnvioClienteDeps {
  readonly outbox: AlertasOutboxPort;
  readonly plantillas: PlantillasFueraVentanaPort;
  readonly panel: AvisoEnvioBloqueadoPort;
}

export interface EnvioClienteInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly sucursalNombre: string;
  readonly conversationId: string;
  readonly phone: string;
  readonly phoneNumberId: string;
  readonly texto: string;
  readonly ultimoMensajeClienteAt: Date | null;
  readonly ahora: Date;
  /** Identifica ESTE envio: el outbox no lo duplica. */
  readonly dedupeKey: string;
}

export type ResultadoEnvioCliente = { readonly enviado: true; readonly modo: "texto" | "plantilla" } | { readonly enviado: false; readonly motivo: MotivoBloqueoEnvio };

const unaLinea = (t: string, max: number): string => t.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

export async function enviarAlClienteRespetandoVentana(deps: EnvioClienteDeps, input: EnvioClienteInput): Promise<ResultadoEnvioCliente> {
  const to = toWhatsAppRecipient(input.phone);
  const bloquear = async (motivo: MotivoBloqueoEnvio): Promise<ResultadoEnvioCliente> => {
    await deps.panel.bloqueado({ organizationId: input.organizationId, propertyId: input.propertyId, conversationId: input.conversationId, motivo });
    return { enviado: false, motivo };
  };
  if (!to) return bloquear("telefono_invalido");
  const dentro = decidirEnvioAlCliente({ ultimoMensajeClienteAt: input.ultimoMensajeClienteAt, ahora: input.ahora, plantilla: { nombre: "-", idioma: "es_MX", aprobada: true } }).modo === "texto";
  const decision = dentro ? ({ modo: "texto" } as const) : decidirEnvioAlCliente({ ultimoMensajeClienteAt: input.ultimoMensajeClienteAt, ahora: input.ahora, plantilla: await deps.plantillas.resolver(input.organizationId) });
  if (decision.modo === "bloqueado") return bloquear(decision.motivo);
  if (decision.modo === "texto") {
    await deps.outbox.encolar(input.organizationId, input.dedupeKey, { to, phone_number_id: input.phoneNumberId, body: input.texto, transaccional: true });
    return { enviado: true, modo: "texto" };
  }
  const texto = unaLinea(input.texto, PARAM_TEXTO_MAX);
  await deps.outbox.encolar(input.organizationId, input.dedupeKey, {
    to,
    phone_number_id: input.phoneNumberId,
    body: texto.length > 0 ? texto : "Mensaje de la sucursal",
    transaccional: true,
    solo_plantilla: true,
    template: { name: decision.plantilla.nombre, language: decision.plantilla.idioma, params: [unaLinea(input.sucursalNombre, 60) || "la sucursal", texto.length > 0 ? texto : "-"] },
  });
  return { enviado: true, modo: "plantilla" };
}

function esBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

/** Plantilla aprobada de la organizacion (`core.whatsapp_plantilla_resolver`, solo sistema). Base sin migrar = sin plantilla (no envia). */
export function crearPlantillasFueraVentanaPostgres(db: TenantDbSession): PlantillasFueraVentanaPort {
  return {
    resolver: (organizationId) =>
      runWithSavepointFallback<PlantillaFueraVentana | null>({
        session: db,
        savepointName: "sp_restaurantes_plantilla_fuera_ventana",
        primary: async () => {
          const { rows } = await db.query<{ nombre: string; idioma: string }>(`select nombre, idioma from core.whatsapp_plantilla_resolver($1::uuid, $2);`, [organizationId, EVENTO_PLANTILLA_FUERA_VENTANA]);
          return rows[0] ? { nombre: rows[0].nombre, idioma: rows[0].idioma, aprobada: true } : null;
        },
        isRecoverable: esBaseSinMigrar,
        fallback: async () => null,
      }),
  };
}

/** Campana: `restaurantes.envio.sin_plantilla`. */
export function crearAvisoEnvioBloqueadoPanel(db: TenantDbSession): AvisoEnvioBloqueadoPort {
  return {
    async bloqueado(i) {
      await emitirNotificacion(db, {
        evento: "restaurantes.envio.sin_plantilla",
        organizationId: i.organizationId,
        propertyId: i.propertyId,
        clave: i.conversationId,
        parametros: { motivo: i.motivo },
        entidadTipo: "whatsapp_conversation",
        entidadId: i.conversationId,
      });
    },
  };
}

export class InMemoryPlantillasFueraVentana implements PlantillasFueraVentanaPort {
  plantilla: PlantillaFueraVentana | null = null;
  async resolver(): Promise<PlantillaFueraVentana | null> {
    return this.plantilla;
  }
}

export class InMemoryAvisoEnvioBloqueado implements AvisoEnvioBloqueadoPort {
  readonly avisos: { organizationId: string; propertyId: string; conversationId: string; motivo: MotivoBloqueoEnvio }[] = [];
  async bloqueado(i: { organizationId: string; propertyId: string; conversationId: string; motivo: MotivoBloqueoEnvio }): Promise<void> {
    this.avisos.push(i);
  }
}
