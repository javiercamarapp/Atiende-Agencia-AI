// Medidor mensual de mensajes por plan (PL-16) -- adaptador de `@atiende/whatsapp-gateway::MedidorMensajes` sobre
// `@atiende/db::planes-topes` (migracion 0045) y productor de los avisos in-app del 80 % y del tope.
//
// Reglas (ver docs/PLANES-TOPES.md):
//   * Solo el despacho de WhatsApp mide: cada mensaje saliente ENVIADO suma 1 al mes de la organizacion (en la zona horaria del
//     negocio). Las respuestas del agente salen por el mismo outbox, asi que no se cuentan aparte.
//   * Por defecto el plan PERMITE y registra el excedente. Solo un plan con accion `pausar` y tope consumido omite avisos
//     PROACTIVOS no criticos (queda registrado con su motivo); lo transaccional y lo critico SIEMPRE salen.
//   * Base sin migrar o error del medidor: se envia igual (el medidor nunca deja a un cliente final sin respuesta).
//   * Avisos: owner/admin de la organizacion y superadmin, dedupe por organizacion y mes (`<org>:<periodo>`), sin PII en el texto
//     (solo numeros y el slug de la organizacion).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { decidirEnvio, emitirNotificacion, registrarMensaje } from "@atiende/db";
import type { MedidorMensajes } from "@atiende/whatsapp-gateway";

export type VerticalMedidor = "citas" | "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "despachos";

/** Ids del catalogo, literales (el catalogo y su prueba verifican que este archivo los emite). */
const EVENTOS_ORGANIZACION = {
  hoteles: { aviso80: "hoteles.plan.mensajes_80", excedido: "hoteles.plan.mensajes_excedido" },
  restaurantes: { aviso80: "restaurantes.plan.mensajes_80", excedido: "restaurantes.plan.mensajes_excedido" },
  rentas: { aviso80: "rentas.plan.mensajes_80", excedido: "rentas.plan.mensajes_excedido" },
  licitaciones: { aviso80: "licitaciones.plan.mensajes_80", excedido: "licitaciones.plan.mensajes_excedido" },
  citas: { aviso80: "citas.plan.mensajes_80", excedido: "citas.plan.mensajes_excedido" },
  despachos: { aviso80: "despachos.plan.mensajes_80", excedido: "despachos.plan.mensajes_excedido" },
} as const satisfies Record<VerticalMedidor, { aviso80: string; excedido: string }>;

const EVENTOS_SUPERADMIN = { aviso80: "superadmin.plan.mensajes_80", excedido: "superadmin.plan.mensajes_excedido" } as const;

/** El slug es un codigo, pero puede pasar de los 40 caracteres que admite un parametro de notificacion. */
function slugCorto(slug: string | null): string {
  const limpio = (slug ?? "organizacion").replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 40);
  return limpio.length > 0 ? limpio : "organizacion";
}

export function crearMedidorMensajes(db: TenantDbSession, vertical: VerticalMedidor): MedidorMensajes {
  return {
    async antesDeEnviar(ctx) {
      // Lo transaccional (respuesta a un cliente que escribio) NUNCA se omite: no hace falta ni consultar.
      if (!ctx.proactivo) return { permitir: true };
      const decision = await decidirEnvio(db, { organizationId: ctx.organizationId, proactivo: true, critico: ctx.critico });
      if (decision.permitir) return { permitir: true };
      const motivo = decision.motivo ?? "tope_mensajes_plan";
      await registrarMensaje(db, { organizationId: ctx.organizationId, refTipo: `wa_omitido_${ctx.label}`, refId: ctx.itemId, proactivo: true, omitido: true, motivo });
      return { permitir: false, motivo };
    },

    async despuesDeEnviar(ctx) {
      const r = await registrarMensaje(db, { organizationId: ctx.organizationId, refTipo: `wa_${ctx.label}`, refId: ctx.itemId, proactivo: ctx.proactivo });
      if (!r.disponible || !r.registrado || r.cruce === "ninguno" || r.periodo === null) return;
      const clave = `${ctx.organizationId}:${r.periodo}`;
      const parametros = { usado: r.usado ?? 0, limite: r.limite ?? 0 };
      const eventos = EVENTOS_ORGANIZACION[vertical];
      const eventoOrg = r.cruce === "aviso80" ? eventos.aviso80 : eventos.excedido;
      const eventoSuper = r.cruce === "aviso80" ? EVENTOS_SUPERADMIN.aviso80 : EVENTOS_SUPERADMIN.excedido;
      await emitirNotificacion(db, { evento: eventoOrg, organizationId: ctx.organizationId, clave, parametros, entidadTipo: "plan_mensajes" });
      await emitirNotificacion(db, { evento: eventoSuper, organizationId: null, clave, parametros: { ...parametros, organizacion: slugCorto(r.slug) }, entidadTipo: "plan_mensajes" });
    },
  };
}
