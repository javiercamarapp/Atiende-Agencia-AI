// "Listo para produccion": verificaciones PURAS sobre un estado ya leido (sin I/O, sin `process.env`, sin reloj). Cada verificacion es una
// funcion que recibe el estado y devuelve una `Verificacion`; la ruta (routes/superadmin-preflight.ts) y la CLI (scripts/verify-go-live) solo
// leen y delegan aqui, asi el calculo se prueba sin base de datos.
//
// REGLAS:
//   * Solo NOMBRES de variable y booleanos: jamas un valor, prefijo ni longitud de un secreto (como integrations-status.ts). Una comparacion de
//     secretos (CRON_SECRET contra INTERNAL_SECRET) sale como booleano y nunca se imprime ninguno de los dos.
//   * `null` en una fuente = "no se pudo medir" y NUNCA se lee como "todo bien": la verificacion sale `aviso` con su razon.
//   * El checklist de datos del dueño NO se duplica: `buildOnboardingChecklist` (domain-restaurantes) se consume tal cual con un snapshot
//     armado desde los hechos de la base.
import { createHash, timingSafeEqual } from "node:crypto";
import type { OrgEquipo, OrgPreflightHechos, PreflightSucursalHechos } from "@atiende/db";
import { buildOnboardingChecklist, leerHorarioPersistido } from "@atiende/domain-restaurantes";
import type { OnboardingBranchSnapshot, OnboardingItem, OnboardingPantalla } from "@atiende/domain-restaurantes";
import { esProduccion } from "../env.ts";
import { computeIntegrationsStatus } from "../integrations-status.ts";
import type { EnvSnapshot, IntegrationStatus } from "../integrations-status.ts";
import type { CronConEstado } from "../salud/motor.ts";

export type PreflightEstado = "ok" | "falta" | "aviso" | "no_aplica";
export type PreflightArea = "entorno" | "crons" | "equipo" | "canal" | "privacidad" | "voz" | "datos" | "monitoreo";

export const AREAS_PREFLIGHT: readonly PreflightArea[] = ["entorno", "crons", "equipo", "canal", "privacidad", "voz", "datos", "monitoreo"];

export interface Verificacion {
  readonly id: string;
  readonly area: PreflightArea;
  readonly titulo: string;
  readonly estado: PreflightEstado;
  /** Sin secretos ni datos personales. */
  readonly detalle: string;
  readonly como_resolver: { readonly texto: string; /** Ruta relativa de la pantalla que lo arregla (null = no hay pantalla: es un paso externo). */ readonly enlace: string | null };
}

/** Una fuente de lectura: `ok` con su dato, o la razon honesta por la que no se pudo leer. */
export type FuentePreflight<T> = { readonly estado: "ok"; readonly dato: T } | { readonly estado: "no_migrado" | "error" | "no_disponible" };

export interface PreflightEntrada {
  readonly organizacion: { readonly id: string; readonly nombre: string; readonly slug: string; readonly vertical: string; readonly estado: string };
  /** Snapshot de variables de entorno (en la ruta, `process.env`). Nunca se imprime. */
  readonly env: EnvSnapshot;
  /** Latidos de TODOS los crons declarados (misma funcion que /superadmin/salud); `null` = no se pudo leer. */
  readonly crons: readonly CronConEstado[] | null;
  readonly equipo: FuentePreflight<OrgEquipo | null>;
  readonly hechos: FuentePreflight<OrgPreflightHechos | null>;
  /** El superadmin que consulta tiene un factor MFA activo; `null` = no se pudo medir (base sin migrar). */
  readonly mfaDelConsultante: boolean | null;
}

const RUTA_INTEGRACIONES = "/superadmin/integraciones";
const RUTA_SALUD = "/superadmin/salud";

const ROLES_DE_GESTION: ReadonlySet<string> = new Set(["owner", "admin", "staff"]);

function lista(nombres: readonly string[], tope = 8): string {
  if (nombres.length <= tope) return nombres.join(", ");
  return `${nombres.slice(0, tope).join(", ")} y ${nombres.length - tope} más`;
}

function isSet(env: EnvSnapshot, name: string): boolean {
  const v = env[name];
  return v !== undefined && v.trim() !== "";
}

function iguales(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function integracion(estados: readonly IntegrationStatus[], id: string): IntegrationStatus | undefined {
  return estados.find((e) => e.id === id);
}

/** Verificacion de una integracion del inventario: ok si esta configurada; si no, `falta` con los NOMBRES que faltan. */
function porIntegracion(
  estados: readonly IntegrationStatus[],
  def: { readonly id: string; readonly area: PreflightArea; readonly titulo: string; readonly integracion: string; readonly sinConfigurar: PreflightEstado; readonly resolver: string },
): Verificacion {
  const i = integracion(estados, def.integracion);
  if (!i) {
    return { id: def.id, area: def.area, titulo: def.titulo, estado: "aviso", detalle: "La integración no está en el inventario de este despliegue.", como_resolver: { texto: def.resolver, enlace: RUTA_INTEGRACIONES } };
  }
  return {
    id: def.id,
    area: def.area,
    titulo: def.titulo,
    estado: i.configurada ? "ok" : def.sinConfigurar,
    detalle: i.configurada ? "Configurada." : `Faltan las variables: ${i.faltantes.join(", ")}.`,
    como_resolver: { texto: def.resolver, enlace: RUTA_INTEGRACIONES },
  };
}

function noAplica(id: string, area: PreflightArea, titulo: string, detalle: string): Verificacion {
  return { id, area, titulo, estado: "no_aplica", detalle, como_resolver: { texto: "No requiere acción.", enlace: null } };
}

function noMedible(id: string, area: PreflightArea, titulo: string, razon: string, resolver: string, enlace: string | null): Verificacion {
  return { id, area, titulo, estado: "aviso", detalle: `No se pudo medir: ${razon}`, como_resolver: { texto: resolver, enlace } };
}

function razonDeFuente(f: { readonly estado: "no_migrado" | "error" | "no_disponible" }, migracion: string): string {
  if (f.estado === "no_migrado" || f.estado === "no_disponible") return `no disponible aún en este despliegue (falta aplicar la migración ${migracion}).`;
  return "la lectura falló; reintenta en unos minutos.";
}

// ───────────────────────── entorno ─────────────────────────

function verificacionesEntorno(entrada: PreflightEntrada, estados: readonly IntegrationStatus[]): Verificacion[] {
  const { env } = entrada;
  const prod = esProduccion(env);
  const out: Verificacion[] = [];

  out.push({
    id: "entorno.contexto",
    area: "entorno",
    titulo: "El entorno verificado es producción",
    estado: prod ? "ok" : "aviso",
    detalle: prod ? (((env.VERCEL_ENV ?? "").trim() === "") ? "NODE_ENV=production (sin VERCEL_ENV)." : "VERCEL_ENV=production.") : "Este despliegue no es producción: la lista describe SU entorno, no el de producción.",
    como_resolver: { texto: "Corre la verificación contra el entorno de producción.", enlace: null },
  });

  out.push(
    porIntegracion(estados, { id: "entorno.meta", area: "entorno", titulo: "WhatsApp / Meta (webhook y envío)", integracion: "whatsapp-meta", sinConfigurar: "falta", resolver: "Carga las tres variables de Meta en Vercel (Production) y vuelve a verificar." }),
  );
  out.push(
    porIntegracion(estados, { id: "entorno.openrouter", area: "entorno", titulo: "Modelo de lenguaje (OpenRouter)", integracion: "llm-openrouter", sinConfigurar: "falta", resolver: "Carga OPENROUTER_API_KEY en Vercel (Production); sin ella el agente no contesta." }),
  );
  out.push(
    porIntegracion(estados, { id: "entorno.correo", area: "entorno", titulo: "Correo transaccional (Resend y remitente)", integracion: "resend-correo", sinConfigurar: "falta", resolver: "Carga RESEND_API_KEY y RESEND_FROM_EMAIL (remitente de un dominio verificado en Resend)." }),
  );

  // APP_BASE_URL: en produccion es obligatoria y https (sin ella la API ni arranca); fuera de produccion solo avisa.
  const baseUrl = (env.APP_BASE_URL ?? "").trim();
  const baseOk = baseUrl !== "" && (!prod || /^https:\/\//i.test(baseUrl));
  out.push({
    id: "entorno.app_base_url",
    area: "entorno",
    titulo: "Origen público de la app (APP_BASE_URL)",
    estado: baseOk ? "ok" : prod ? "falta" : "aviso",
    detalle: baseUrl === "" ? "APP_BASE_URL no está definida: los enlaces de invitación, reset y magic link no tienen un origen propio." : baseOk ? "Definida." : "APP_BASE_URL no es https://.",
    como_resolver: { texto: "Define APP_BASE_URL con el origen https:// de la app en Vercel (Production).", enlace: RUTA_INTEGRACIONES },
  });

  const origenes = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origenesPropios = origenes.filter((o) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o));
  out.push({
    id: "entorno.allowed_origins",
    area: "entorno",
    titulo: "Orígenes permitidos (ALLOWED_ORIGINS)",
    estado: origenesPropios.length > 0 ? "ok" : prod ? "falta" : "aviso",
    detalle: origenesPropios.length > 0 ? `${origenesPropios.length} origen(es) propio(s) declarado(s).` : "Solo está el origen de desarrollo (localhost): el panel real sería rechazado por la guarda de Origin.",
    como_resolver: { texto: "Declara en ALLOWED_ORIGINS el origen https:// del panel.", enlace: RUTA_INTEGRACIONES },
  });

  const mfaRequerida = ["1", "true"].includes((env.SUPERADMIN_MFA_REQUIRED ?? "").toLowerCase());
  out.push({
    id: "entorno.mfa_requerida",
    area: "entorno",
    titulo: "MFA obligatoria del superadmin (SUPERADMIN_MFA_REQUIRED)",
    estado: mfaRequerida ? "ok" : "aviso",
    detalle: mfaRequerida ? "Activada." : "No está activada: las acciones sensibles solo exigen MFA a quien ya enroló un factor.",
    como_resolver: { texto: "Enrola tu MFA en Seguridad y define SUPERADMIN_MFA_REQUIRED=true.", enlace: "/superadmin/seguridad" },
  });
  return out;
}

// ───────────────────────── crons ─────────────────────────

/** Crons que usa la vertical: el despacho de WhatsApp, la retencion de privacidad de plataforma y, en restaurantes, todos los `/internal/restaurantes/*`
 *  declarados en vercel.json (la lista sale de los propios latidos: un cron nuevo en vercel.json aparece sin tocar este archivo). */
export function cronsRelevantes(vertical: string, declarados: readonly string[]): readonly string[] {
  const fijos = ["/internal/whatsapp/dispatch", "/internal/plataforma/privacidad-retencion"];
  const propios = vertical === "restaurantes" ? declarados.filter((p) => p.startsWith("/internal/restaurantes/")) : [];
  return [...new Set([...fijos, ...propios])].sort((a, b) => a.localeCompare(b));
}

/** Crons que no bloquean el go-live de restaurantes: el despacho a SoftRestaurant depende de un tercero (distribuidor del POS). */
const CRONS_NO_BLOQUEANTES: ReadonlySet<string> = new Set(["/internal/restaurantes/softrestaurant-dispatch"]);
/** Cron que solo importa si alguna sucursal activa tiene la voz habilitada. */
const CRON_SOLO_CON_VOZ = "/internal/restaurantes/voz-huerfanas";

function algunaVozHabilitada(hechos: PreflightEntrada["hechos"]): boolean | null {
  if (hechos.estado !== "ok" || hechos.dato?.restaurantes?.sucursales == null) return null;
  return hechos.dato.restaurantes.sucursales.some((s) => s.activa && s.voz === "habilitada");
}

function verificacionesCrons(entrada: PreflightEntrada): Verificacion[] {
  const out: Verificacion[] = [];
  const { env } = entrada;

  // Vercel Cron manda `Authorization: Bearer $CRON_SECRET`; la API compara contra INTERNAL_SECRET: si difieren (o falta CRON_SECRET) todo cron da 401 antes de dejar latido.
  const cron = env.CRON_SECRET;
  const interno = env.INTERNAL_SECRET;
  const alineados = cron !== undefined && cron.trim() !== "" && interno !== undefined && interno.trim() !== "" && iguales(cron, interno);
  out.push({
    id: "crons.secreto",
    area: "crons",
    titulo: "CRON_SECRET alineado con INTERNAL_SECRET",
    estado: alineados ? "ok" : "falta",
    detalle: alineados
      ? "Ambos existen y coinciden."
      : cron === undefined || cron.trim() === ""
        ? "CRON_SECRET no está definida: Vercel Cron no manda credencial y cada cron recibe 401 sin dejar latido."
        : "CRON_SECRET no coincide con INTERNAL_SECRET: cada cron recibe 401 sin dejar latido.",
    como_resolver: { texto: "Define CRON_SECRET en Vercel (Production) con el mismo valor que INTERNAL_SECRET y vuelve a desplegar.", enlace: RUTA_INTEGRACIONES },
  });

  if (entrada.crons === null) {
    out.push(noMedible("crons.latidos", "crons", "Latidos de los crons", "la lectura de latidos falló.", "Abre Salud operativa y reintenta.", RUTA_SALUD));
    return out;
  }
  for (const nombre of cronsRelevantes(entrada.organizacion.vertical, entrada.crons.map((c) => c.cronName))) {
    const c = entrada.crons.find((x) => x.cronName === nombre);
    const id = `crons${nombre.replace(/^\/internal/, "").replace(/\//g, ".")}`;
    const titulo = `Cron ${nombre}`;
    const como = { texto: "Revisa Salud operativa: confirma CRON_SECRET, el plan de Vercel y que el deploy de producción sea el vigente.", enlace: RUTA_SALUD };
    if (!c) {
      out.push({ id, area: "crons", titulo, estado: "aviso", detalle: "El cron no está declarado en vercel.json de este despliegue.", como_resolver: como });
      continue;
    }
    if (nombre === CRON_SOLO_CON_VOZ && algunaVozHabilitada(entrada.hechos) === false) {
      out.push(noAplica(id, "crons", titulo, "Ninguna sucursal activa tiene la voz habilitada."));
      continue;
    }
    const ultimo = c.heartbeat?.lastFinishedAt ?? null;
    const detalle: Record<CronConEstado["estado"], string> = {
      ok: `Corrió dentro de su cadencia${ultimo ? ` (último latido ${ultimo})` : ""}.`,
      vencido: `Pasó su cadencia sin latido nuevo${ultimo ? ` (último latido ${ultimo})` : ""}.`,
      sin_latido: "Nunca ha dejado un latido.",
      error: `El último latido terminó en error (${c.heartbeat?.consecutiveFailures ?? 0} fallo(s) seguidos).`,
    };
    const noOk: PreflightEstado = CRONS_NO_BLOQUEANTES.has(nombre) ? "aviso" : "falta";
    const texto = c.estado !== "ok" && noOk === "aviso" ? `${detalle[c.estado]} No bloquea: depende del distribuidor del POS.` : detalle[c.estado];
    out.push({ id, area: "crons", titulo, estado: c.estado === "ok" ? "ok" : noOk, detalle: texto, como_resolver: como });
  }
  return out;
}

// ───────────────────────── equipo ─────────────────────────

function verificacionesEquipo(entrada: PreflightEntrada): Verificacion[] {
  const out: Verificacion[] = [];
  const ficha = `/superadmin/organizaciones/${entrada.organizacion.id}`;
  const resolverEquipo = { texto: "Invita al equipo desde la ficha de la organización (sección Equipo).", enlace: ficha };

  const e = entrada.equipo;
  if (e.estado !== "ok" || e.dato === null) {
    const razon = e.estado === "ok" ? "la organización no se encontró." : razonDeFuente(e, "0053_superadmin_alta_equipo");
    out.push(noMedible("equipo.owner", "equipo", "Al menos un owner activo", razon, resolverEquipo.texto, ficha));
    out.push(noMedible("equipo.cobertura", "equipo", "Alguien del equipo en cada sucursal activa", razon, resolverEquipo.texto, ficha));
  } else {
    const owners = e.dato.miembros.filter((m) => m.rol === "owner").length;
    const pendientes = e.dato.invitaciones.filter((i) => !i.vencida && i.rol === "owner").length;
    out.push({
      id: "equipo.owner",
      area: "equipo",
      titulo: "Al menos un owner activo",
      estado: owners > 0 ? "ok" : "falta",
      detalle:
        owners > 0
          ? `${owners} owner(s) con acceso.`
          : pendientes > 0
            ? "Nadie tiene acceso de owner todavía: hay una invitación de owner pendiente de aceptar."
            : "Nadie puede entrar al panel: la organización no tiene ningún owner.",
      como_resolver: resolverEquipo,
    });
    const activas = e.dato.sucursales.filter((s) => s.estado === "active");
    const sinCobertura = activas.filter((s) => !e.dato!.miembros.some((m) => ROLES_DE_GESTION.has(m.rol) && (m.propertyIds === null || m.propertyIds.includes(s.id)))).map((s) => s.nombre);
    out.push({
      id: "equipo.cobertura",
      area: "equipo",
      titulo: "Alguien del equipo en cada sucursal activa",
      estado: activas.length === 0 ? "falta" : sinCobertura.length === 0 ? "ok" : "falta",
      detalle:
        activas.length === 0
          ? "No hay ninguna sucursal activa."
          : sinCobertura.length === 0
            ? `Las ${activas.length} sucursal(es) activa(s) tienen owner, admin o staff con alcance.`
            : `Sin owner, admin ni staff con alcance en: ${lista(sinCobertura)}.`,
      como_resolver: resolverEquipo,
    });
  }

  out.push(
    entrada.mfaDelConsultante === null
      ? noMedible("equipo.mfa_superadmin", "equipo", "El superadmin que verifica tiene MFA activa", "la MFA no está disponible aún en este despliegue (falta aplicar la migración de MFA).", "Aplica la migración de MFA y enrola tu autenticador.", "/superadmin/seguridad")
      : {
          id: "equipo.mfa_superadmin",
          area: "equipo",
          titulo: "El superadmin que verifica tiene MFA activa",
          estado: entrada.mfaDelConsultante ? "ok" : "falta",
          detalle: entrada.mfaDelConsultante ? "Tu factor MFA está activo." : "Tu cuenta de superadmin no tiene un factor MFA activo.",
          como_resolver: { texto: "Enrola tu autenticador en Seguridad.", enlace: "/superadmin/seguridad" },
        },
  );
  return out;
}

// ───────────────────────── restaurantes: canal, privacidad, voz, datos ─────────────────────────

function enlaceDelDueno(slug: string, pantalla: OnboardingPantalla): string {
  return `/restaurantes/${slug}/${pantalla}`;
}

const RESPONSABLE_TEXTO: Readonly<Record<OnboardingItem["responsable"], string>> = {
  plataforma: "Lo cierra la plataforma",
  dueno: "Lo cierra el dueño",
  meta: "Depende de Meta y del número de cada sucursal",
  distribuidor_pos: "Depende del distribuidor del POS",
};

function sucursalesActivas(h: readonly PreflightSucursalHechos[]): readonly PreflightSucursalHechos[] {
  return h.filter((s) => s.activa);
}

function verificacionesCanal(entrada: PreflightEntrada, hechos: OrgPreflightHechos | null, razonHechos: string | null): Verificacion[] {
  const { slug } = entrada.organizacion;
  const resolverCanal = { texto: "Registra el número de WhatsApp (general o por sucursal) en Configuración del panel.", enlace: enlaceDelDueno(slug, "configuracion") };
  const out: Verificacion[] = [];
  const r = hechos?.restaurantes ?? null;

  if (r === null) {
    const motivo = razonHechos ?? "la organización no es de restaurantes.";
    const fila = (id: string, titulo: string) => (hechos !== null ? noAplica(id, "canal", titulo, motivo) : noMedible(id, "canal", titulo, motivo, resolverCanal.texto, resolverCanal.enlace));
    out.push(fila("canal.general", "Canal de WhatsApp de la organización"));
    out.push(fila("canal.sucursales", "Cada sucursal activa tiene a dónde recibir mensajes"));
  } else {
    if (r.whatsappGeneral === null) out.push(noMedible("canal.general", "canal", "Canal de WhatsApp de la organización", "falta una tabla de WhatsApp en este despliegue.", resolverCanal.texto, resolverCanal.enlace));
    else
      out.push({
        id: "canal.general",
        area: "canal",
        titulo: "Canal de WhatsApp de la organización",
        estado: r.whatsappGeneral ? "ok" : "falta",
        detalle: r.whatsappGeneral ? "Hay un número general conectado." : "No hay número general de WhatsApp conectado.",
        como_resolver: resolverCanal,
      });

    if (r.sucursales === null) out.push(noMedible("canal.sucursales", "canal", "Cada sucursal activa tiene a dónde recibir mensajes", "no se pudieron leer las sucursales.", resolverCanal.texto, resolverCanal.enlace));
    else {
      const activas = sucursalesActivas(r.sucursales);
      const general = r.whatsappGeneral === true;
      const sinNumero = activas.filter((s) => !s.conWhatsappPropio && !general).map((s) => s.nombre);
      const soloGeneral = activas.filter((s) => !s.conWhatsappPropio && general).map((s) => s.nombre);
      out.push({
        id: "canal.sucursales",
        area: "canal",
        titulo: "Cada sucursal activa tiene a dónde recibir mensajes",
        estado: activas.length === 0 ? "falta" : sinNumero.length > 0 ? "falta" : soloGeneral.length > 0 ? "aviso" : "ok",
        detalle:
          activas.length === 0
            ? "No hay ninguna sucursal activa."
            : sinNumero.length > 0
              ? `Sin número de WhatsApp (propio ni general) en: ${lista(sinNumero)}.`
              : soloGeneral.length > 0
                ? `Atendidas solo por el número general (sin número propio): ${lista(soloGeneral)}.`
                : "Todas las sucursales activas tienen número propio.",
        como_resolver: resolverCanal,
      });
    }
  }

  // Plantillas: el envio sale como texto libre salvo las que se declaren aprobadas por Meta (WHATSAPP_APPROVED_TEMPLATES).
  const declaradas = (entrada.env.WHATSAPP_APPROVED_TEMPLATES ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;
  out.push({
    id: "canal.plantillas",
    area: "canal",
    titulo: "Plantillas de estado de pedido declaradas",
    estado: declaradas > 0 ? "ok" : "aviso",
    detalle: declaradas > 0 ? `${declaradas} plantilla(s) declarada(s) como aprobadas por Meta.` : "No hay plantillas declaradas: los avisos de estado salen como texto libre y Meta solo los entrega dentro de la ventana de 24 horas.",
    como_resolver: { texto: "Aprueba las plantillas en Meta y declara sus nombres en WHATSAPP_APPROVED_TEMPLATES.", enlace: RUTA_INTEGRACIONES },
  });
  return out;
}

function verificacionesPrivacidad(entrada: PreflightEntrada, hechos: OrgPreflightHechos | null, razonHechos: string | null): Verificacion[] {
  const resolver = { texto: "Captura el responsable y la URL https del aviso integral en Privacidad del panel.", enlace: enlaceDelDueno(entrada.organizacion.slug, "privacidad") };
  const r = hechos?.restaurantes ?? null;
  if (r === null) {
    const motivo = razonHechos ?? "la organización no es de restaurantes.";
    const fila = (id: string, titulo: string) => (hechos !== null ? noAplica(id, "privacidad", titulo, motivo) : noMedible(id, "privacidad", titulo, motivo, resolver.texto, resolver.enlace));
    return [fila("privacidad.config", "Configuración de privacidad completa"), fila("privacidad.version", "Versión del aviso vigente")];
  }
  const p = r.privacidad;
  if (p === null) {
    return [
      noMedible("privacidad.config", "privacidad", "Configuración de privacidad completa", "falta la migración de privacidad en este despliegue.", resolver.texto, resolver.enlace),
      noMedible("privacidad.version", "privacidad", "Versión del aviso vigente", "falta la migración de privacidad en este despliegue.", resolver.texto, resolver.enlace),
    ];
  }
  const faltantes = [p.conResponsable ? null : "responsable del tratamiento", p.conAviso ? null : "URL del aviso integral"].filter((x): x is string => x !== null);
  return [
    {
      id: "privacidad.config",
      area: "privacidad",
      titulo: "Configuración de privacidad completa",
      estado: p.configurada && faltantes.length === 0 ? "ok" : "falta",
      detalle: !p.configurada ? "La organización no ha configurado su privacidad." : faltantes.length === 0 ? "Responsable y URL del aviso capturados." : `Falta: ${faltantes.join(" y ")}.`,
      como_resolver: resolver,
    },
    {
      id: "privacidad.version",
      area: "privacidad",
      titulo: "Versión del aviso vigente",
      estado: p.avisosPublicados > 0 ? "ok" : "aviso",
      detalle: p.avisosPublicados > 0 ? `${p.avisosPublicados} versión(es) del aviso publicada(s)${p.version ? `; versión de la configuración: ${p.version}` : ""}.` : "La plataforma no tiene ninguna versión publicada del aviso de esta organización.",
      como_resolver: resolver,
    },
  ];
}

function verificacionesVoz(entrada: PreflightEntrada, hechos: OrgPreflightHechos | null, razonHechos: string | null): Verificacion[] {
  const slug = entrada.organizacion.slug;
  const resolverCreds = { texto: "Carga GEMINI_API_KEY y VOICE_PREVIEW_TOKEN_SECRET en Vercel (Production).", enlace: RUTA_INTEGRACIONES };
  const resolverDecision = { texto: "Habilita o deshabilita la voz a propósito en Agente de voz del panel.", enlace: enlaceDelDueno(slug, "agente-voz") };
  const r = hechos?.restaurantes ?? null;
  if (r === null || r.sucursales === null) {
    const motivo = r === null ? (razonHechos ?? "la organización no es de restaurantes.") : "no se pudieron leer las sucursales.";
    if (r === null && hechos !== null) return [noAplica("voz.credenciales", "voz", "Credenciales de voz", motivo), noAplica("voz.decision", "voz", "Decisión de voz por sucursal", motivo)];
    return [noMedible("voz.credenciales", "voz", "Credenciales de voz", motivo, resolverCreds.texto, resolverCreds.enlace), noMedible("voz.decision", "voz", "Decisión de voz por sucursal", motivo, resolverDecision.texto, resolverDecision.enlace)];
  }
  const activas = sucursalesActivas(r.sucursales);
  const habilitadas = activas.filter((s) => s.voz === "habilitada");
  const sinDecision = activas.filter((s) => s.voz === "sin_configurar").map((s) => s.nombre);
  const credenciales = isSet(entrada.env, "GEMINI_API_KEY") && isSet(entrada.env, "VOICE_PREVIEW_TOKEN_SECRET");
  return [
    habilitadas.length === 0
      ? noAplica("voz.credenciales", "voz", "Credenciales de voz", "Ninguna sucursal activa tiene la voz habilitada.")
      : {
          id: "voz.credenciales",
          area: "voz",
          titulo: "Credenciales de voz",
          estado: credenciales ? "ok" : "falta",
          detalle: credenciales ? "GEMINI_API_KEY y VOICE_PREVIEW_TOKEN_SECRET definidas." : "La voz está habilitada pero faltan GEMINI_API_KEY y/o VOICE_PREVIEW_TOKEN_SECRET: las llamadas no se atienden.",
          como_resolver: resolverCreds,
        },
    {
      id: "voz.decision",
      area: "voz",
      titulo: "Decisión de voz por sucursal",
      estado: activas.length === 0 ? "aviso" : sinDecision.length === 0 ? "ok" : "aviso",
      detalle: activas.length === 0 ? "No hay sucursales activas." : sinDecision.length === 0 ? "Cada sucursal activa tiene su decisión de voz (habilitada o deshabilitada a propósito)." : `Sin decisión de voz en: ${lista(sinDecision)}.`,
      como_resolver: resolverDecision,
    },
  ];
}

/** Convierte los hechos de la base en el snapshot del checklist del dueño (misma interpretacion de `cargarOnboarding`). */
export function snapshotDeOnboarding(hechos: NonNullable<OrgPreflightHechos["restaurantes"]>, env: EnvSnapshot): Parameters<typeof buildOnboardingChecklist>[0] | null {
  if (hechos.sucursales === null) return null;
  const sucursales: OnboardingBranchSnapshot[] = hechos.sucursales.map((s) => {
    if (!s.activa) return { nombre: s.nombre, activa: false, conCoordenadas: s.conCoordenadas, productosDisponibles: 0, conHorario: false, dobleTurno: false, conPedidoMinimo: false, zonasDeEntrega: 0, conWhatsappPropio: s.conWhatsappPropio, voz: "sin_configurar" };
    const horario = leerHorarioPersistido(s.horario) ?? [];
    const porDia = new Map<number, number>();
    for (const t of horario) for (const d of t.dias) porDia.set(d, (porDia.get(d) ?? 0) + 1);
    return {
      nombre: s.nombre,
      activa: true,
      conCoordenadas: s.conCoordenadas,
      productosDisponibles: s.productosDisponibles,
      conHorario: horario.length > 0,
      dobleTurno: [...porDia.values()].some((n) => n > 1),
      conPedidoMinimo: s.conPedidoMinimoDomicilio,
      zonasDeEntrega: s.zonasDeEntrega,
      conWhatsappPropio: s.conWhatsappPropio,
      voz: s.voz,
    };
  });
  return {
    sucursales,
    whatsappGeneral: hechos.whatsappGeneral === true,
    agenteConfigurado: hechos.agente?.configurada === true,
    nombreDelAsistente: hechos.agente?.conNombre === true,
    pedidos: hechos.hayPedidos === true ? 1 : 0,
    vozProveedorListo: isSet(env, "GEMINI_API_KEY") && isSet(env, "VOICE_PREVIEW_TOKEN_SECRET"),
    privacidadDisponible: hechos.privacidad !== null,
    avisoPublicado: hechos.privacidad?.conAviso === true,
  };
}

function verificacionesDatos(entrada: PreflightEntrada, hechos: OrgPreflightHechos | null, razonHechos: string | null): Verificacion[] {
  const slug = entrada.organizacion.slug;
  const r = hechos?.restaurantes ?? null;
  if (r === null) {
    const motivo = razonHechos ?? "la organización no es de restaurantes.";
    return [hechos !== null ? noAplica("datos.checklist", "datos", "Checklist de datos del restaurante", motivo) : noMedible("datos.checklist", "datos", "Checklist de datos del restaurante", motivo, "Aplica la migración 0057 y vuelve a verificar.", null)];
  }
  const snapshot = snapshotDeOnboarding(r, entrada.env);
  if (snapshot === null) return [noMedible("datos.checklist", "datos", "Checklist de datos del restaurante", "no se pudieron leer las sucursales ni su menú.", "Revisa que las migraciones de restaurantes estén aplicadas.", null)];

  const checklist = buildOnboardingChecklist(snapshot);
  return checklist.items.map((item): Verificacion => {
    const estado: PreflightEstado = item.estado === "hecho" ? "ok" : item.estado === "externo" ? "aviso" : item.obligatorio ? "falta" : "aviso";
    // Casi todos los detalles del dueño ya nombran las sucursales que faltan; solo se agregan las que el detalle no menciona.
    const sinMencionar = item.estado === "hecho" ? [] : item.faltantes.filter((n) => !item.detalle.includes(n));
    const faltantes = sinMencionar.length > 0 ? ` Sucursales: ${lista(sinMencionar)}.` : "";
    return {
      id: `datos.${item.id}`,
      area: "datos",
      titulo: item.titulo,
      estado,
      detalle: `${item.detalle}${faltantes}`,
      como_resolver: { texto: `${RESPONSABLE_TEXTO[item.responsable]}.`, enlace: item.estado === "hecho" ? null : enlaceDelDueno(slug, item.pantalla) },
    };
  });
}

// ───────────────────────── monitoreo ─────────────────────────

function verificacionesMonitoreo(estados: readonly IntegrationStatus[]): Verificacion[] {
  const activos = ["alertas-correo", "alertas-webhook", "sentry"].filter((id) => integracion(estados, id)?.configurada === true);
  return [
    {
      id: "monitoreo.alertas",
      area: "monitoreo",
      titulo: "Alertas salientes (correo, webhook o Sentry)",
      estado: activos.length > 0 ? "ok" : "aviso",
      detalle: activos.length > 0 ? `${activos.length} canal(es) de alerta configurado(s).` : "Ningún canal de alerta saliente: si un cron falla, nadie se entera hasta abrir Salud operativa.",
      como_resolver: { texto: "Configura ALERTAS_EMAIL_DESTINATARIOS, ALERTAS_WEBHOOK_URL o SENTRY_DSN.", enlace: RUTA_INTEGRACIONES },
    },
  ];
}

// ───────────────────────── ensamblado ─────────────────────────

export interface ResultadoPreflight {
  readonly verificaciones: readonly Verificacion[];
  readonly resumen: { readonly total: number; readonly ok: number; readonly falta: number; readonly aviso: number; readonly no_aplica: number; readonly pendientes: number; readonly listo: boolean };
}

export function evaluarPreflight(entrada: PreflightEntrada): ResultadoPreflight {
  const estados = computeIntegrationsStatus(entrada.env);
  const hechos = entrada.hechos.estado === "ok" ? entrada.hechos.dato : null;
  const razonHechos = entrada.hechos.estado === "ok" ? (hechos === null ? "la organización no se encontró." : null) : razonDeFuente(entrada.hechos, "0057_superadmin_preflight_organizacion");

  const verificaciones: Verificacion[] = [
    ...verificacionesEntorno(entrada, estados),
    ...verificacionesCrons(entrada),
    ...verificacionesEquipo(entrada),
    ...verificacionesCanal(entrada, hechos, razonHechos),
    ...verificacionesPrivacidad(entrada, hechos, razonHechos),
    ...verificacionesVoz(entrada, hechos, razonHechos),
    ...verificacionesDatos(entrada, hechos, razonHechos),
    ...verificacionesMonitoreo(estados),
  ];
  const cuenta = (e: PreflightEstado) => verificaciones.filter((v) => v.estado === e).length;
  const falta = cuenta("falta");
  // Fail-closed: una fuente que no se pudo leer (0053/0057 sin aplicar, fallo de lectura, latidos ilegibles u organizacion
  // no encontrada) deja verificaciones en `aviso`, que no cuentan como `falta`; sin esta condicion el resumen diria "listo"
  // sin haber medido equipo, canal, privacidad, voz ni datos.
  const fuentesLeidas = entrada.equipo.estado === "ok" && entrada.hechos.estado === "ok" && hechos !== null && entrada.crons !== null;
  return { verificaciones, resumen: { total: verificaciones.length, ok: cuenta("ok"), falta, aviso: cuenta("aviso"), no_aplica: cuenta("no_aplica"), pendientes: falta, listo: falta === 0 && fuentesLeidas } };
}
