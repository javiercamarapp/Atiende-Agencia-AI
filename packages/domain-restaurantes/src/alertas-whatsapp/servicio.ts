// Barrido de alertas: por cada escalacion o cliente sin respuesta de una sucursal con alertas activas, encola el aviso de WhatsApp (SOLO plantilla aprobada,
// nunca texto libre: el gerente casi nunca esta dentro de la ventana de 24 h) o degrada al panel registrando el motivo. Idempotente: el outbox dedupe por
// (alerta, destino) y el registro unico impide repetir la decision. NO envia nada por si mismo; el despachador de WhatsApp drena el outbox.
import { actorHash } from "../rate-limit.ts";
import { decidirAlerta } from "./decision.ts";
import type { AlertaCandidata, AlertaSucursalConfig, AlertasOutboxPort, AlertasPanelPort, AlertasRepositorio, MotivoDegradacion, TipoAlerta } from "./tipos.ts";

export interface AlertasDeps {
  readonly repo: AlertasRepositorio;
  readonly outbox: AlertasOutboxPort;
  readonly panel: AlertasPanelPort;
}

export interface ResumenAlertas {
  readonly disponible: boolean;
  readonly encoladas: number;
  readonly degradadas: number;
  readonly sinConfig: number;
  readonly errores: number;
}

export const TEXTO_TIPO_ALERTA: Readonly<Record<TipoAlerta, string>> = {
  escalada: "Un cliente pidio hablar con una persona",
  sin_respuesta: "Un cliente espera respuesta",
};

/** Texto de respaldo del payload (el outbox exige `body`); con `solo_plantilla` a Meta solo viaja la plantilla. */
export function cuerpoAlerta(tipo: TipoAlerta, sucursal: string, minutos: number): string {
  return `${TEXTO_TIPO_ALERTA[tipo]} en ${sucursal} (${minutos} min). Revise Conversaciones en el panel.`;
}

function sinSaltos(t: string, respaldo: string): string {
  const limpio = t.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
  return limpio.length > 0 ? limpio : respaldo;
}

export function payloadAlerta(config: AlertaSucursalConfig, c: AlertaCandidata, to: string): Record<string, unknown> {
  return {
    to,
    phone_number_id: config.phoneNumberIdAviso,
    body: cuerpoAlerta(c.tipo, config.sucursalNombre, c.minutos),
    // Aviso proactivo al personal: solo plantilla aprobada (nunca texto libre) y que el tope de mensajes del plan no lo omita.
    solo_plantilla: true,
    critico: true,
    template: { name: config.plantillaNombre, language: config.plantillaIdioma, params: [TEXTO_TIPO_ALERTA[c.tipo], sinSaltos(config.sucursalNombre, "la sucursal"), String(Math.max(0, Math.round(c.minutos)))] },
  };
}

export async function barrerAlertas(deps: AlertasDeps, ahora: Date, limite = 50): Promise<ResumenAlertas> {
  const lectura = await deps.repo.candidatas(ahora, limite);
  if (!lectura.disponible) return { disponible: false, encoladas: 0, degradadas: 0, sinConfig: 0, errores: 0 };
  const configs = new Map<string, AlertaSucursalConfig | null>();
  let encoladas = 0;
  let degradadas = 0;
  let sinConfig = 0;
  let errores = 0;
  for (const c of lectura.valor) {
    try {
      // El panel SIEMPRE se entera de un cliente sin respuesta en una conversacion (no hay otro aviso para eso), con o sin WhatsApp configurado.
      if (c.tipo === "sin_respuesta" && c.clave.startsWith("c:")) await deps.panel.sinRespuesta(c);
      if (!configs.has(c.propertyId)) configs.set(c.propertyId, await deps.repo.leerConfig(c.organizationId, c.propertyId));
      const config = configs.get(c.propertyId) ?? null;
      if (config === null) {
        sinConfig += 1;
        continue;
      }
      const decision = decidirAlerta(config, ahora);
      const base = { organizationId: c.organizationId, propertyId: c.propertyId, tipo: c.tipo, clave: c.clave } as const;
      if (decision.accion === "panel") {
        const nueva = await deps.repo.registrar({ ...base, destinoHash: "", estado: "degradada_panel", motivo: decision.motivo });
        if (nueva) {
          await deps.panel.degradada(c, decision.motivo);
          degradadas += 1;
        }
        continue;
      }
      for (const to of decision.destinatarios) {
        const hash = actorHash(to);
        // Primero la cola (idempotente por dedupeKey) y despues el registro: si algo falla entre los dos, el reintento no duplica el envio.
        await deps.outbox.encolar(c.organizationId, `alerta:${c.tipo}:${c.clave}:${hash.slice(0, 16)}`, payloadAlerta(config, c, to));
        if (await deps.repo.registrar({ ...base, destinoHash: hash, estado: "encolada", motivo: null })) encoladas += 1;
      }
    } catch {
      errores += 1; // una alerta que falla no detiene el barrido ni las demas
    }
  }
  return { disponible: true, encoladas, degradadas, sinConfig, errores };
}

export type { MotivoDegradacion };
