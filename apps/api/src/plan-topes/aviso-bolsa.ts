// Avisos de BOLSA del plan medido (80 %, 100 % y uso justo) a owner/admin (in-app y correo) y, al pasar el uso justo, a
// superadmin. Corre dentro del cron diario /internal/plataforma/prueba-avisos (no ocupa un cupo de cron nuevo: 40 de 40).
//
// Cada aviso se RECLAMA en la base (`core.cobro_reclamar_aviso_bolsa`, organizacion + mes + metrica + umbral): sale una sola
// vez aunque el cron corra varias veces. Cada organizacion corre en SU PROPIA transaccion de sistema. Nada se corta: los avisos
// solo informan (el excedente se cobra con la tarifa del plan y lo que pasa del uso justo se revisa con el cliente).
// Base sin migrar: `disponible: false`, sin tocar nada.
import { calcularFacturaPlanMedido, umbralBolsa } from "@atiende/billing";
import { destinatariosAvisoPrueba, emitirNotificacion } from "@atiende/db";
import type { MetricaBolsa, OrganizacionMedidaRow } from "@atiende/db";
import { escapeHtml, renderCorreo } from "@atiende/core-email";
import { mesActualEn } from "../routes/cobro-planes.ts";
import type { AppDeps } from "../deps.ts";

export interface ResumenAvisosBolsa {
  readonly disponible: boolean;
  readonly organizaciones: number;
  readonly avisos: number;
  readonly errores: number;
}

const EVENTO: Readonly<Record<80 | 100 | 150, string>> = { 80: "restaurantes.cobro.bolsa_80", 100: "restaurantes.cobro.bolsa_100", 150: "restaurantes.cobro.uso_justo" };
const ETIQUETA: Readonly<Record<MetricaBolsa, string>> = { minutos_voz: "Minutos de voz", conversaciones_wa: "Conversaciones de WhatsApp" };

function slugCorto(slug: string): string {
  const limpio = slug.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 40);
  return limpio.length > 0 ? limpio : "organizacion";
}

async function correo(deps: AppDeps, org: OrganizacionMedidaRow, destinatarios: readonly string[], umbral: 80 | 100 | 150, metrica: MetricaBolsa, usado: number, incluido: number, periodo: string): Promise<void> {
  if (!deps.env.resend.apiKey || destinatarios.length === 0) return;
  const enlace = `${deps.env.appBaseUrl}/restaurantes/${org.slug}/consumo`;
  const titulo = umbral === 80 ? "Va en el 80 % de lo incluido en su plan" : umbral === 100 ? "Ya usó todo lo incluido en su plan este mes" : "Su consumo pasó el uso justo de su plan";
  const detalle = `${ETIQUETA[metrica]}: ${usado.toLocaleString("es-MX")} de ${incluido.toLocaleString("es-MX")} incluidos.`;
  const html = renderCorreo({
    titulo,
    preheader: detalle,
    etiqueta: { texto: "Consumo", color: "#B45309" },
    parrafosHtml: [escapeHtml(detalle), "Nada se corta: sus agentes siguen contestando.", `<a href="${escapeHtml(enlace)}">${escapeHtml(enlace)}</a>`],
    piePorQueLlego: "Recibe este correo porque es administrador de la cuenta.",
  });
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.env.resend.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `bolsa/${org.organizationId}/${periodo}/${metrica}/${umbral}` },
      body: JSON.stringify({ from: deps.env.resend.from, to: destinatarios, subject: titulo, html, text: `${titulo}. ${detalle} ${enlace}` }),
    });
    if (!res.ok) console.error(`aviso-bolsa: Resend respondio ${res.status}`);
  } catch (err) {
    console.error("aviso-bolsa: error de red enviando el correo:", err instanceof Error ? err.name : typeof err);
  }
}

export async function ejecutarAvisosBolsa(deps: AppDeps): Promise<ResumenAvisosBolsa> {
  if (!deps.cobroPlanesRepo) return { disponible: false, organizaciones: 0, avisos: 0, errores: 0 };
  const repo = deps.cobroPlanesRepo;
  const lista = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).organizacionesMedidas(null));
  if (lista.availability === "not_migrated") return { disponible: false, organizaciones: 0, avisos: 0, errores: 0 };
  let avisos = 0;
  let errores = 0;
  for (const org of lista.organizaciones) {
    if (org.vertical !== "restaurantes") continue;
    try {
      avisos += await deps.engine.withAppSession({ userId: null }, async (db) => {
        const rp = repo(db);
        const periodo = mesActualEn(org.zonaHoraria);
        const d = await rp.consumoDetalleRestaurantes(null, org.organizationId, periodo, 0);
        if (!d.detalle) return 0;
        const f = calcularFacturaPlanMedido(org.tarifa, { sucursalesActivas: org.sucursalesActivas, minutosVoz: d.detalle.totales.minutosVoz, conversacionesWa: d.detalle.totales.conversacionesWa });
        let emitidos = 0;
        for (const [metrica, c] of [["minutos_voz", f.voz], ["conversaciones_wa", f.whatsapp]] as const) {
          const umbral = umbralBolsa(c.usado, c.incluido, c.topeUsoJusto === null ? null : org.tarifa.usoJustoPct);
          if (umbral === null) continue;
          // Se reclaman tambien los umbrales menores ya rebasados, para no avisar «80 %» despues de «100 %».
          const umbrales = ([80, 100, 150] as const).filter((u) => u <= umbral);
          const nuevos: Array<80 | 100 | 150> = [];
          for (const u of umbrales) if ((await rp.reclamarAvisoBolsa(org.organizationId, periodo, metrica, u)).reclamado) nuevos.push(u);
          const mayor = nuevos.length > 0 ? nuevos[nuevos.length - 1]! : null;
          if (mayor === null) continue;
          const parametros = { metrica: ETIQUETA[metrica], usado: c.usado, incluido: c.incluido };
          const r = await emitirNotificacion(db, { evento: EVENTO[mayor], organizationId: org.organizationId, clave: `${org.organizationId}:${periodo}:${metrica}:${mayor}`, parametros, entidadTipo: "organizacion" });
          if (r.estado === "emitida") emitidos += 1;
          if (mayor === 150) {
            await emitirNotificacion(db, { evento: "superadmin.cobro.uso_justo_superado", organizationId: null, clave: `${org.organizationId}:${periodo}:${metrica}`, parametros: { organizacion: slugCorto(org.slug), ...parametros }, entidadTipo: "organizacion", entidadId: org.organizationId });
          }
          if (deps.env.resend.apiKey) await correo(deps, org, await destinatariosAvisoPrueba(db, org.organizationId), mayor, metrica, c.usado, c.incluido, periodo);
        }
        return emitidos;
      });
    } catch (err) {
      errores += 1;
      console.error("aviso-bolsa: fallo una organizacion (se reintenta en la siguiente corrida):", (err as { code?: unknown })?.code ?? null, err instanceof Error ? err.name : typeof err);
    }
  }
  return { disponible: true, organizaciones: lista.organizaciones.length, avisos, errores };
}
