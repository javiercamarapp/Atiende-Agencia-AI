// Cliente y helpers puros del Resumen de la consola de superadmin (UNI-RES-superadmin).
// Lee SOLO endpoints que ya existen: GET /superadmin/consola/resumen y /superadmin/consola/agentes-actividad
// (apps/api/src/routes/superadmin-consola.ts, SA-L-05/06) y GET /superadmin/organizations. Cada fuente se pide POR
// SEPARADO desde la pagina: la que falla pinta su propio error sin tumbar a las demas.
//
// REGLA DE LA CASA: nunca inventar una cifra. Cada campo del resumen es `{ valor, codigo?, razon? }`; `valor: null` se
// pinta como "—" con su `razon`, jamas como 0.
import { formatMoney } from "@atiende/ui";
import { PIE_SUPERADMIN, RUTAS_SIN_MENU, TODAS_LAS_RUTAS } from "../rutas.ts";

export interface Campo<T> {
  readonly valor: T | null;
  readonly codigo?: string;
  readonly razon?: string;
}

export interface PuntoDia {
  readonly dia: string;
  readonly cantidad: number;
}

export interface OperacionVertical {
  readonly vertical: string;
  readonly total: number | null;
  readonly razon?: string;
  readonly serie14d: readonly PuntoDia[] | null;
}

export interface ConversacionVertical {
  readonly vertical: string;
  readonly total: number | null;
  readonly razon?: string;
}

export interface ConsolaResumen {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly generadoEn: string;
  readonly hoy: string;
  readonly organizaciones: Campo<{ total: number; demo: number; porVertical: readonly { vertical: string; total: number; demo: number }[] }>;
  readonly gastoIa: Campo<{
    totalUsd: number;
    llmUsd: number;
    otrosUsd: number;
    porCategoria: readonly { categoria: string; usd: number }[];
    serie14d: Campo<readonly { dia: string; usd: number }[]>;
    delta7d: Campo<{ actualUsd: number; previoUsd: number; deltaUsd: number; pct: number | null }>;
  }>;
  readonly tokens: Campo<{ total: number; entrada: number; salida: number }>;
  readonly operaciones: Campo<{
    total: number;
    porVertical: readonly OperacionVertical[];
    serie14d: readonly PuntoDia[];
    verticalesSinFuente: readonly string[];
  }>;
  readonly vozMinutos: Campo<number>;
  readonly sucursales: Campo<number>;
  readonly usuarios: Campo<{ total: number; staff: number; superadmins: number }>;
  readonly conversacionesWa: Campo<{ total: number; porVertical: readonly ConversacionVertical[] }>;
  readonly resueltasSinHumano: Campo<{ dia: string; resueltas: number; total: number; porcentaje: number | null; nota: string }>;
  readonly mrr: Campo<{ totalMxn: number; organizacionesConPrecio: number; organizacionesSinPrecio: number }>;
}

export interface AgenteActividad {
  readonly vertical: string;
  readonly role: string;
  readonly historico: { readonly llamadas: number; readonly costoUsd: number; readonly fallbacks: number };
  readonly ultimos30Dias: { readonly llamadas: number; readonly costoUsd: number; readonly fallbacks: number };
}

export interface CorridaCron {
  readonly cron: string;
  readonly vertical: string;
  readonly nombre: string;
  readonly estado: string;
  readonly terminoEn: string | null;
  readonly duracionMs: number | null;
  readonly fallosConsecutivos: number;
  readonly tareas: "no medido";
}

export interface AgentesActividad {
  readonly disponible: boolean;
  readonly hoy: string;
  readonly agentes: Campo<readonly AgenteActividad[]>;
  readonly ultimaCorrida: Campo<readonly CorridaCron[]>;
}

export interface OrganizacionConsola {
  readonly id: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "trial" | "active" | "suspended";
  readonly staffCount: number;
}

async function getJson<T>(apiBaseUrl: string, token: string, ruta: string, mensajeError: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(mensajeError);
  return (await res.json()) as T;
}

export const fetchConsolaResumen = (apiBaseUrl: string, token: string) =>
  getJson<ConsolaResumen>(apiBaseUrl, token, "/superadmin/consola/resumen", "No se pudo cargar el resumen de la consola.");

export const fetchAgentesActividad = (apiBaseUrl: string, token: string) =>
  getJson<AgentesActividad>(apiBaseUrl, token, "/superadmin/consola/agentes-actividad", "No se pudo cargar la actividad de los agentes.");

export async function fetchOrganizacionesConsola(apiBaseUrl: string, token: string): Promise<readonly OrganizacionConsola[]> {
  const body = await getJson<{ organizations: OrganizacionConsola[] }>(apiBaseUrl, token, "/superadmin/organizations", "No se pudieron cargar las organizaciones.");
  return body.organizations;
}

// ---- saludo en hora de Mexico ---------------------------------------------------------------------------------------

const TZ = "America/Mexico_City";

/** Hora 0-23 en America/Mexico_City (no la del navegador: el Resumen habla del dia de negocio de Mexico). */
export function horaMexico(fecha: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(fecha);
  return Number(h) % 24;
}

export function saludoMexico(fecha: Date = new Date()): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  const hora = horaMexico(fecha);
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

// ---- rutas --------------------------------------------------------------------------------------------------------

const RUTAS_CONOCIDAS: ReadonlySet<string> = new Set([...TODAS_LAS_RUTAS.map((r) => r.to), ...PIE_SUPERADMIN.map((p) => p.to), ...RUTAS_SIN_MENU]);

/** Una pildora o flecha solo se pinta si su destino existe en `rutas.ts`: cero botones muertos. */
export function rutaExiste(to: string): boolean {
  return RUTAS_CONOCIDAS.has(to);
}

// ---- agrupacion de roles del gateway en las tarjetas de "Orquestacion de agentes" -------------------------------------

export interface GrupoAgente {
  readonly clave: string;
  readonly nombre: string;
  /** Ruta de la ficha del agente (SA-L-09). Hoy ninguna existe: la tarjeta se pinta sin flecha ni enlace. */
  readonly ruta: string;
  readonly incluye: (role: string) => boolean;
}

export const GRUPOS_AGENTE: readonly GrupoAgente[] = [
  { clave: "extractor", nombre: "Agente extractor", ruta: "/superadmin/agente-extractor", incluye: (r) => r === "licitaciones:requirement_extractor" },
  { clave: "conciliacion", nombre: "Agente de conciliación", ruta: "/superadmin/agente-conciliacion", incluye: (r) => r === "despachos:conciliacion_llm_agent" },
  {
    clave: "whatsapp",
    nombre: "Agente de WhatsApp y voz",
    ruta: "/superadmin/agente-whatsapp",
    incluye: (r) => r.endsWith(":whatsapp_agent") || r.endsWith(":whatsapp_agent_escalated") || r === "rentas:mensajeria_agent",
  },
  { clave: "copiloto", nombre: "Copiloto", ruta: "/superadmin/copiloto", incluye: (r) => r === "superadmin:copiloto" },
];

export interface ActividadGrupo {
  readonly grupo: GrupoAgente;
  readonly llamadas: number;
  readonly costoUsd: number;
}

/** Suma el historico por grupo. `llamadas === 0` => "Sin corridas registradas." (nunca un 0 inventado). */
export function actividadPorGrupo(filas: readonly AgenteActividad[]): readonly ActividadGrupo[] {
  return GRUPOS_AGENTE.map((grupo) => {
    const propias = filas.filter((f) => grupo.incluye(f.role));
    return { grupo, llamadas: propias.reduce((s, f) => s + f.historico.llamadas, 0), costoUsd: propias.reduce((s, f) => s + f.historico.costoUsd, 0) };
  });
}

/** Costo historico por agente/rol para la dona: los 4 grupos y "Otros roles" (p. ej. los data_chat). Solo segmentos con costo. */
export function costoPorAgente(filas: readonly AgenteActividad[]): readonly { etiqueta: string; valor: number }[] {
  const segmentos = actividadPorGrupo(filas).map((a) => ({ etiqueta: a.grupo.nombre, valor: a.costoUsd }));
  const otros = filas.filter((f) => !GRUPOS_AGENTE.some((g) => g.incluye(f.role))).reduce((s, f) => s + f.historico.costoUsd, 0);
  if (otros > 0) segmentos.push({ etiqueta: "Otros roles", valor: otros });
  return segmentos.filter((s) => s.valor > 0);
}

// ---- formatos -----------------------------------------------------------------------------------------------------

export const usd = (n: number): string => `US$${formatMoney(n)}`;

export function fechaHoraCorta(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("es-MX", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const NOMBRE_VERTICAL: Readonly<Record<string, string>> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
  plataforma: "Plataforma",
};

/** Ventana de la serie diaria que el endpoint entrega (14 dias): 7d recorta; 30d y Todo muestran lo que hay, y se dice. */
export const DIAS_SERIE = 14;
export function ventanaSerie<T>(serie: readonly T[], rango: "7" | "30" | "todo"): readonly T[] {
  return rango === "7" ? serie.slice(-7) : serie;
}
