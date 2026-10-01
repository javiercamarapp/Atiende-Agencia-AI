// Despachador de alertas salientes (PL-04). Orquesta: redaccion -> piso por hora por
// (tipo, destino) -> canal. Canales (todos opcionales, cada uno solo si esta configurado):
//   - correo  : Resend (RESEND_API_KEY ya existente) a ALERTAS_EMAIL_DESTINATARIOS
//   - webhook : POST JSON firmado (HMAC) a ALERTAS_WEBHOOK_URL
//   - sentry  : evento via envelope HTTP si hay SENTRY_DSN (sin dependencia de SDK)
// Sin ningun canal configurado, `notificar` no hace nada (devuelve resultados vacios): el
// codigo es seguro de desplegar antes de tener credenciales.
//
// `resultados` vacio = ningun canal configurado (o fallo interno ya contenido): nunca se lanza.
import { createHash, randomUUID } from "node:crypto";
import { redactarTexto, redactarValor } from "./redaccion.ts";
import { crearLimitadorAlertas, type LimitadorAlertas } from "./limite-horario.ts";
import {
  enviarAlertaASentry,
  enviarAlertaPorCorreo,
  enviarAlertaPorWebhook,
  motivoUrlWebhookInvalida,
  parsearDsnSentry,
  type DsnSentry,
  type FetchLike,
  type ResultadoCanal,
} from "./canales.ts";
import type { AlertaSaliente, CanalAlerta, DespachadorAlertas, ResultadoAlerta, ResultadoCanalAlerta } from "./tipos.ts";

export interface ConfigAlertas {
  readonly correo: { readonly apiKey: string; readonly from: string; readonly destinatarios: readonly string[] } | null;
  readonly webhook: { readonly url: string; readonly secreto: string | null } | null;
  readonly sentry: DsnSentry | null;
  readonly limitePorHora: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Construye la config desde variables de entorno. Cualquier valor ausente o invalido APAGA ese
 *  canal (nunca lanza): una variable mal escrita jamas debe tumbar el arranque de la API. */
export function configAlertasDesdeEnv(env: Record<string, string | undefined>, resend: { readonly apiKey: string | null; readonly from: string }): ConfigAlertas {
  const destinatarios = (env.ALERTAS_EMAIL_DESTINATARIOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
  const webhookUrl = env.ALERTAS_WEBHOOK_URL?.trim() || null;
  return {
    correo: resend.apiKey && destinatarios.length > 0 ? { apiKey: resend.apiKey, from: resend.from, destinatarios } : null,
    webhook: webhookUrl && motivoUrlWebhookInvalida(webhookUrl) === null ? { url: webhookUrl, secreto: env.ALERTAS_WEBHOOK_SECRETO?.trim() || null } : null,
    sentry: parsearDsnSentry(env.SENTRY_DSN),
    limitePorHora: Number.parseInt(env.ALERTAS_LIMITE_POR_HORA ?? "", 10),
  };
}

/** Destino apto para logs/resultados: nunca el correo completo ni la URL completa. */
function destinoCorto(canal: CanalAlerta, destino: string): string {
  if (canal === "correo") return `***@${destino.split("@")[1] ?? "?"}`;
  try {
    return new URL(destino).host;
  } catch {
    return "?";
  }
}

export interface DependenciasDespachador {
  readonly fetchImpl?: FetchLike;
  readonly limitador?: LimitadorAlertas;
  readonly ahora?: () => Date;
}

export function crearDespachadorAlertas(config: ConfigAlertas, deps: DependenciasDespachador = {}): DespachadorAlertas {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const limitador = deps.limitador ?? crearLimitadorAlertas({ limitePorHora: config.limitePorHora });
  const ahora = deps.ahora ?? (() => new Date());

  async function enviarUno(canal: CanalAlerta, destino: string, tipo: string, enviar: () => Promise<ResultadoCanal>): Promise<ResultadoCanalAlerta> {
    const corto = destinoCorto(canal, destino);
    try {
      if (!(await limitador.permitir(tipo, `${canal}:${destino}`))) return { canal, destino: corto, estado: "suprimido_por_limite" };
      const r = await enviar();
      return { canal, destino: corto, estado: r.ok ? "enviado" : "error", detalle: r.detalle };
    } catch {
      return { canal, destino: corto, estado: "error", detalle: "excepcion_interna" };
    }
  }

  return {
    async notificar(alerta: AlertaSaliente): Promise<ResultadoAlerta> {
      try {
        const limpia: AlertaSaliente = {
          tipo: redactarTexto(alerta.tipo).slice(0, 120),
          severidad: alerta.severidad,
          titulo: redactarTexto(alerta.titulo),
          detalle: redactarTexto(alerta.detalle),
          ...(alerta.href ? { href: redactarTexto(alerta.href) } : {}),
          ...(alerta.contexto ? { contexto: redactarValor(alerta.contexto) as Record<string, unknown> } : {}),
        };
        const t = ahora();
        const hora = t.toISOString().slice(0, 13).replace(/\D/g, "");
        const tareas: Promise<ResultadoCanalAlerta>[] = [];

        if (config.correo) {
          const c = config.correo;
          for (const to of c.destinatarios) {
            const clave = `alerta-${createHash("sha256").update(`${limpia.tipo}|${to}`).digest("hex").slice(0, 24)}-${hora}`;
            tareas.push(enviarUno("correo", to, limpia.tipo, () => enviarAlertaPorCorreo({ apiKey: c.apiKey, from: c.from, to, alerta: limpia, claveIdempotencia: clave, fetchImpl })));
          }
        }
        if (config.webhook) {
          const w = config.webhook;
          tareas.push(enviarUno("webhook", w.url, limpia.tipo, () => enviarAlertaPorWebhook({ url: w.url, secreto: w.secreto, alerta: limpia, ahora: t, fetchImpl })));
        }
        if (config.sentry) {
          const s = config.sentry;
          tareas.push(enviarUno("sentry", s.endpoint, limpia.tipo, () => enviarAlertaASentry({ dsn: s, alerta: limpia, ahora: t, eventId: randomUUID().replace(/-/g, ""), fetchImpl })));
        }

        if (tareas.length === 0) return { resultados: [] };
        return { resultados: await Promise.all(tareas) };
      } catch {
        return { resultados: [] };
      }
    },
  };
}
