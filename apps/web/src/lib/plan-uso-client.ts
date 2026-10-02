// Cliente de la pantalla "Plan y uso" y del banner de plan (GET /billing/uso y POST /billing/portal de
// apps/api/src/routes/billing.ts). Funciones puras sobre `fetch` inyectado para probarlas sin red.
export type AccionTope = "avisar" | "cobrar" | "pausar";

export interface PlanUso {
  readonly periodo: string;
  readonly zonaHoraria: string;
  readonly mensajes: {
    readonly usado: number;
    readonly limite: number | null;
    readonly accion: AccionTope | null;
    readonly excedente: number;
    readonly proactivosOmitidos: number;
  };
  readonly plan: { readonly id: string; readonly nombre: string } | null;
  readonly prueba: { readonly activa: boolean; readonly terminaEn: string | null; readonly diasRestantes: number | null };
  readonly portal: { readonly disponible: boolean; readonly explicacion: string | null };
}

export type LecturaPlanUso = { readonly disponible: true; readonly uso: PlanUso } | { readonly disponible: false; readonly motivo: string };

export class PlanUsoError extends Error {
  readonly status: number | null;
  constructor(mensaje: string, status: number | null) {
    super(mensaje);
    this.name = "PlanUsoError";
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function mensajePorEstado(status: number): string {
  if (status === 401) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (status === 403) return "No tienes permiso para esta acción.";
  if (status === 503) return "Esta función no está disponible en este entorno.";
  return "El servidor no pudo atender la solicitud. Inténtalo de nuevo.";
}

function numero(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function pedir(fetchFn: FetchLike, url: string, token: string, init: RequestInit = {}): Promise<{ status: number; cuerpo: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
  } catch {
    throw new PlanUsoError("No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.", null);
  }
  let cuerpo: Record<string, unknown> = {};
  try {
    cuerpo = (await res.json()) as Record<string, unknown>;
  } catch {
    // cuerpo vacio o no JSON: se resuelve por el estado
  }
  if (!res.ok) {
    // El API responde `{ code, message }`. El 503 trae el motivo honesto (falta la llave de Stripe, sin suscripcion...) y se muestra tal cual.
    const mensajeServidor = typeof cuerpo.message === "string" && cuerpo.message.length > 0 ? cuerpo.message : null;
    throw new PlanUsoError(res.status === 503 && mensajeServidor ? mensajeServidor : mensajePorEstado(res.status), res.status);
  }
  return { status: res.status, cuerpo };
}

export async function leerPlanUso(fetchFn: FetchLike, apiBaseUrl: string, token: string): Promise<LecturaPlanUso> {
  const { cuerpo } = await pedir(fetchFn, `${apiBaseUrl}/billing/uso`, token);
  if (cuerpo.disponible !== true) return { disponible: false, motivo: typeof cuerpo.motivo === "string" ? cuerpo.motivo : "Todavía no disponible en este despliegue." };
  const m = (cuerpo.mensajes ?? {}) as Record<string, unknown>;
  const p = cuerpo.plan as Record<string, unknown> | null | undefined;
  const t = (cuerpo.prueba ?? {}) as Record<string, unknown>;
  const portal = (cuerpo.portal ?? {}) as Record<string, unknown>;
  if (typeof cuerpo.periodo !== "string" || numero(m.usado) === null) throw new PlanUsoError("La respuesta del servidor no es válida.", 200);
  return {
    disponible: true,
    uso: {
      periodo: cuerpo.periodo,
      zonaHoraria: typeof cuerpo.zonaHoraria === "string" ? cuerpo.zonaHoraria : "America/Mexico_City",
      mensajes: {
        usado: numero(m.usado) ?? 0,
        limite: numero(m.limite),
        accion: m.accion === "avisar" || m.accion === "cobrar" || m.accion === "pausar" ? m.accion : null,
        excedente: numero(m.excedente) ?? 0,
        proactivosOmitidos: numero(m.proactivosOmitidos) ?? 0,
      },
      plan: p && typeof p.id === "string" ? { id: p.id, nombre: typeof p.nombre === "string" ? p.nombre : p.id } : null,
      prueba: { activa: t.activa === true, terminaEn: typeof t.terminaEn === "string" ? t.terminaEn : null, diasRestantes: numero(t.diasRestantes) },
      portal: { disponible: portal.disponible === true, explicacion: typeof portal.explicacion === "string" ? portal.explicacion : null },
    },
  };
}

/** Crea la sesion del portal de facturacion y devuelve la URL de Stripe. Lanza PlanUsoError con el motivo honesto del servidor. */
export async function abrirPortalFacturacion(fetchFn: FetchLike, apiBaseUrl: string, token: string): Promise<string> {
  const { cuerpo } = await pedir(fetchFn, `${apiBaseUrl}/billing/portal`, token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (typeof cuerpo.url !== "string" || !/^https:\/\//.test(cuerpo.url)) throw new PlanUsoError("La respuesta del servidor no es válida.", 200);
  return cuerpo.url;
}

export type TonoAviso = "warning" | "danger";
export interface AvisoPlan {
  readonly clave: string;
  readonly tono: TonoAviso;
  readonly titulo: string;
  readonly detalle: string;
}

/** Decide que avisos de plan merecen un banner: fin de prueba a 7 dias o menos, 80 % del tope y tope superado. Sin datos: ninguno. */
export function avisosDePlan(uso: PlanUso): readonly AvisoPlan[] {
  const avisos: AvisoPlan[] = [];
  const { prueba, mensajes } = uso;
  if (prueba.activa && prueba.diasRestantes !== null && prueba.diasRestantes >= 0 && prueba.diasRestantes <= 7) {
    const d = prueba.diasRestantes;
    avisos.push({
      clave: `prueba:${d}`,
      tono: d <= 1 ? "danger" : "warning",
      titulo: d === 0 ? "Su prueba termina hoy" : `Su prueba termina en ${d} ${d === 1 ? "día" : "días"}`,
      detalle: "Revise Plan y uso para ver el estado de su cuenta.",
    });
  }
  if (mensajes.limite !== null && mensajes.limite > 0) {
    if (mensajes.usado > mensajes.limite) {
      avisos.push({ clave: `tope:${uso.periodo}:excedido`, tono: "danger", titulo: "Superó el tope de mensajes de su plan", detalle: `Mensajes del mes: ${mensajes.usado} de ${mensajes.limite}.` });
    } else if (mensajes.usado * 100 > mensajes.limite * 80) {
      avisos.push({ clave: `tope:${uso.periodo}:80`, tono: "warning", titulo: "Va en el 80 por ciento del tope de mensajes de su plan", detalle: `Mensajes del mes: ${mensajes.usado} de ${mensajes.limite}.` });
    }
  }
  return avisos;
}
