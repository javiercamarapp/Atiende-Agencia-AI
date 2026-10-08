// verificar-meta-whatsapp — comprobacion de SOLO LECTURA de la conexion con Meta (WhatsApp Business).
//
// Politica: nunca envia mensajes, no registra ni verifica numeros, no toca webhooks ni plantillas. Solo hace GET a Graph API
// por medio de `MetaGraphWhatsAppReader` (que rechaza cualquier otro metodo). El token se lee UNICAMENTE de la variable de
// entorno `WHATSAPP_ACCESS_TOKEN` y jamas se imprime; no se leen archivos de secretos.
//
// Uso (ver README.md):
//   WHATSAPP_ACCESS_TOKEN=... node scripts/verificar-meta-whatsapp/verificar.ts \
//     --waba 1234567890 --numero 1098765=T7 --numero 1098766=T3 [--version v23.0] [--json]
//
// Codigos de salida: 0 verde, 1 amarillo, 2 rojo, 3 uso incorrecto (argumentos o token ausente).
import { pathToFileURL } from "node:url";
import {
  MetaGraphReadError,
  MetaGraphWhatsAppReader,
  esVersionGraphValida,
  redactarSecretos,
  type MetaNumero,
  type MetaPlantilla,
  type MetaWaba,
} from "../../packages/whatsapp-gateway/src/providers/meta-graph-reader.ts";

export type Semaforo = "verde" | "amarillo" | "rojo";

/** Plantillas de restaurantes que espera el producto (nombre en Meta, idioma es_MX). Un test las compara con el codigo fuente. */
export const PLANTILLAS_ESPERADAS: readonly string[] = [
  // PLANTILLAS_ESTADO_PEDIDO (packages/domain-restaurantes/src/order-notifications.ts)
  "pedido_confirmado",
  "pedido_en_camino",
  "pedido_listo_para_recoger",
  "pedido_entregado",
  "pedido_cancelado",
  // PLANTILLAS_AUTOPILOTO (packages/domain-restaurantes/src/autopiloto/servicio.ts); ver docs/PLANTILLAS-WHATSAPP.md
  "pedido_aprobado",
  "pedido_no_confirmado",
  "cancelacion_no_posible",
  "compensacion_sin_costo_extra",
  "compensacion_reposicion",
  "compensacion_descuento",
  "pedido_recibido",
];

export interface Motivo {
  readonly nivel: "amarillo" | "rojo";
  readonly texto: string;
}

export interface InformeNumero {
  readonly etiqueta: string;
  readonly phone_number_id: string;
  readonly leido: boolean;
  readonly display_phone_number: string | null;
  readonly verified_name: string | null;
  readonly quality_rating: string | null;
  readonly platform_type: string | null;
  readonly is_on_biz_app: boolean | null;
  readonly throughput: string | null;
  readonly status: string | null;
  readonly name_status: string | null;
  readonly semaforo: Semaforo;
  readonly motivos: readonly Motivo[];
}

export interface InformePlantillaEsperada {
  readonly nombre: string;
  /** Mejor estado entre sus idiomas, o `FALTA`. */
  readonly estado: string;
}

export interface InformeWaba {
  readonly waba_id: string;
  readonly leida: boolean;
  readonly nombre: string | null;
  readonly limite_mensajeria: string | null;
  readonly plantillas_total: number | null;
  readonly plantillas_por_estado: Readonly<Record<string, number>>;
  readonly plantillas_esperadas: readonly InformePlantillaEsperada[];
  /** `null` si no se pudo comprobar (sin META_APP_ID o error de lectura). */
  readonly app_suscrita: boolean | null;
  readonly apps_suscritas: readonly { readonly id: string | null; readonly name: string | null }[];
  readonly semaforo: Semaforo;
  readonly motivos: readonly Motivo[];
}

export interface Informe {
  readonly version_graph: string;
  readonly semaforo: Semaforo;
  readonly codigo: 0 | 1 | 2;
  readonly numeros: readonly InformeNumero[];
  readonly wabas: readonly InformeWaba[];
  readonly motivos: readonly Motivo[];
}

export interface Opciones {
  readonly wabas: readonly string[];
  readonly numeros: readonly { readonly id: string; readonly etiqueta: string }[];
  readonly version: string | undefined;
  readonly json: boolean;
  readonly esperaCoexistencia: boolean;
  readonly ayuda: boolean;
}

export class UsoIncorrectoError extends Error {}

export const AYUDA = `verificar-meta-whatsapp (solo lectura: nunca envia mensajes ni escribe en Meta)

Uso: WHATSAPP_ACCESS_TOKEN=... node scripts/verificar-meta-whatsapp/verificar.ts [opciones]

  --waba <id>                       WABA a revisar (repetible). Por defecto, WHATSAPP_WABA_IDS.
  --numero <phone_number_id>=<etq>  Numero a revisar con su etiqueta de sucursal (repetible).
  --version vNN.0                   Version de Graph API (por defecto WHATSAPP_GRAPH_API_VERSION o v21.0).
  --sin-coexistencia                No exigir is_on_biz_app (numero que no usa la app WhatsApp Business).
  --json                            Misma informacion en JSON.
  --help                            Esta ayuda.

Variables: WHATSAPP_ACCESS_TOKEN (obligatoria), META_APP_ID, WHATSAPP_WABA_IDS, WHATSAPP_GRAPH_API_VERSION.
Salida: 0 verde, 1 amarillo, 2 rojo, 3 uso incorrecto.`;

export function parseArgs(argv: readonly string[]): Opciones {
  const wabas: string[] = [];
  const numeros: { id: string; etiqueta: string }[] = [];
  let version: string | undefined;
  let json = false;
  let esperaCoexistencia = true;
  let ayuda = false;
  const valorDe = (i: number, nombre: string): string => {
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith("--")) throw new UsoIncorrectoError(`${nombre} requiere un valor`);
    return valor;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--waba": {
        wabas.push(valorDe(i, arg).trim());
        i += 1;
        break;
      }
      case "--numero": {
        const crudo = valorDe(i, arg);
        i += 1;
        const corte = crudo.indexOf("=");
        const id = (corte === -1 ? crudo : crudo.slice(0, corte)).trim();
        const etiqueta = corte === -1 ? "" : crudo.slice(corte + 1).trim();
        if (id.length === 0) throw new UsoIncorrectoError("--numero requiere <phone_number_id>=<etiqueta>");
        numeros.push({ id, etiqueta: etiqueta.length > 0 ? etiqueta : id });
        break;
      }
      case "--version": {
        version = valorDe(i, arg).trim();
        i += 1;
        if (!esVersionGraphValida(version)) throw new UsoIncorrectoError("--version debe tener el formato v23.0");
        break;
      }
      case "--json":
        json = true;
        break;
      case "--sin-coexistencia":
        esperaCoexistencia = false;
        break;
      case "--help":
      case "-h":
        ayuda = true;
        break;
      default:
        throw new UsoIncorrectoError(`argumento desconocido: ${arg}`);
    }
  }
  return { wabas: wabas.filter(Boolean), numeros, version, json, esperaCoexistencia, ayuda };
}

const ORDEN: Record<Semaforo, number> = { verde: 0, amarillo: 1, rojo: 2 };

function peor(motivos: readonly Motivo[]): Semaforo {
  let actual: Semaforo = "verde";
  for (const motivo of motivos) if (ORDEN[motivo.nivel] > ORDEN[actual]) actual = motivo.nivel;
  return actual;
}

/** Tras un token invalido todo lo demas fallaria igual: se corta la verificacion. */
class TokenInvalidoCorta extends Error {}

function textoError(err: unknown): string {
  if (err instanceof MetaGraphReadError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function clasificarError(err: unknown, que: string, /** rojo si es 4xx permanente (no existe o sin acceso) */ rojoSiPermanente: boolean): Motivo {
  if (err instanceof MetaGraphReadError) {
    if (err.tokenInvalido) throw new TokenInvalidoCorta();
    if (rojoSiPermanente && !err.retryable) return { nivel: "rojo", texto: `${que}: no existe o el token no tiene acceso (${textoError(err)})` };
    return { nivel: "amarillo", texto: `${que}: no se pudo verificar (${textoError(err)})` };
  }
  return { nivel: "amarillo", texto: `${que}: no se pudo verificar (${textoError(err)})` };
}

async function revisarNumero(reader: MetaGraphWhatsAppReader, id: string, etiqueta: string, esperaCoexistencia: boolean): Promise<InformeNumero> {
  const vacio = { etiqueta, phone_number_id: id, display_phone_number: null, verified_name: null, quality_rating: null, platform_type: null, is_on_biz_app: null, throughput: null, status: null, name_status: null };
  let numero: MetaNumero;
  try {
    numero = await reader.numero(id);
  } catch (err) {
    const motivo = clasificarError(err, `numero ${etiqueta} (${id})`, true);
    return { ...vacio, leido: false, semaforo: motivo.nivel, motivos: [motivo] };
  }
  const motivos: Motivo[] = [];
  const calidad = numero.quality_rating ?? null;
  if (calidad === "RED") motivos.push({ nivel: "rojo", texto: `numero ${etiqueta}: calidad RED` });
  else if (calidad === "YELLOW") motivos.push({ nivel: "amarillo", texto: `numero ${etiqueta}: calidad YELLOW` });
  else if (calidad !== "GREEN") motivos.push({ nivel: "amarillo", texto: `numero ${etiqueta}: calidad ${calidad ?? "no informada"} (se esperaba GREEN)` });
  if (esperaCoexistencia && numero.is_on_biz_app !== true) {
    motivos.push({ nivel: "amarillo", texto: `numero ${etiqueta}: is_on_biz_app no es true (se esperaba coexistencia con la app WhatsApp Business)` });
  }
  if (numero.status !== undefined && numero.status !== "CONNECTED") motivos.push({ nivel: "amarillo", texto: `numero ${etiqueta}: estado ${numero.status} (se esperaba CONNECTED)` });
  return {
    ...vacio,
    leido: true,
    display_phone_number: numero.display_phone_number ?? null,
    verified_name: numero.verified_name ?? null,
    quality_rating: calidad,
    platform_type: numero.platform_type ?? null,
    is_on_biz_app: typeof numero.is_on_biz_app === "boolean" ? numero.is_on_biz_app : null,
    throughput: numero.throughput?.level ?? null,
    status: numero.status ?? null,
    name_status: numero.name_status ?? null,
    semaforo: peor(motivos),
    motivos,
  };
}

const PRIORIDAD_ESTADO = ["APPROVED", "PENDING", "IN_APPEAL", "PAUSED", "REJECTED", "DISABLED"];

function mejorEstado(estados: readonly string[]): string {
  for (const estado of PRIORIDAD_ESTADO) if (estados.includes(estado)) return estado;
  return estados[0] ?? "FALTA";
}

async function revisarWaba(reader: MetaGraphWhatsAppReader, wabaId: string, appId: string | null): Promise<InformeWaba> {
  const motivos: Motivo[] = [];
  let waba: MetaWaba | null = null;
  try {
    waba = await reader.waba(wabaId);
  } catch (err) {
    motivos.push(clasificarError(err, `WABA ${wabaId}`, true));
  }

  let plantillas: MetaPlantilla[] | null = null;
  try {
    plantillas = await reader.plantillas(wabaId);
  } catch (err) {
    motivos.push(clasificarError(err, `plantillas de la WABA ${wabaId}`, false));
  }
  const porEstado: Record<string, number> = {};
  const estadosPorNombre = new Map<string, string[]>();
  for (const plantilla of plantillas ?? []) {
    const estado = plantilla.status ?? "SIN_ESTADO";
    porEstado[estado] = (porEstado[estado] ?? 0) + 1;
    if (plantilla.name) estadosPorNombre.set(plantilla.name, [...(estadosPorNombre.get(plantilla.name) ?? []), estado]);
  }
  const esperadas: InformePlantillaEsperada[] = PLANTILLAS_ESPERADAS.map((nombre) => ({ nombre, estado: estadosPorNombre.has(nombre) ? mejorEstado(estadosPorNombre.get(nombre)!) : "FALTA" }));
  if (plantillas !== null) {
    const sinAprobar = esperadas.filter((e) => e.estado !== "APPROVED");
    if (sinAprobar.length > 0) motivos.push({ nivel: "amarillo", texto: `WABA ${wabaId}: plantillas sin aprobar: ${sinAprobar.map((e) => `${e.nombre} (${e.estado})`).join(", ")}` });
  }

  let apps: { id: string | null; name: string | null }[] = [];
  let appSuscrita: boolean | null = null;
  try {
    apps = (await reader.appsSuscritas(wabaId)).map((a) => ({ id: a.id ?? null, name: a.name ?? null }));
    if (appId === null) {
      motivos.push({ nivel: "amarillo", texto: `WABA ${wabaId}: falta META_APP_ID, no se comprobo que la app este suscrita` });
    } else {
      appSuscrita = apps.some((a) => a.id === appId);
      if (!appSuscrita) motivos.push({ nivel: "rojo", texto: `WABA ${wabaId}: la app ${appId} no aparece en subscribed_apps` });
    }
  } catch (err) {
    motivos.push(clasificarError(err, `apps suscritas de la WABA ${wabaId}`, false));
  }

  return {
    waba_id: wabaId,
    leida: waba !== null,
    nombre: waba?.name ?? null,
    limite_mensajeria: waba?.whatsapp_business_manager_messaging_limit ?? null,
    plantillas_total: plantillas === null ? null : plantillas.length,
    plantillas_por_estado: porEstado,
    plantillas_esperadas: esperadas,
    app_suscrita: appSuscrita,
    apps_suscritas: apps,
    semaforo: peor(motivos),
    motivos,
  };
}

export async function verificar(opts: Opciones, entorno: Readonly<Record<string, string | undefined>>, fetchImpl?: typeof fetch): Promise<Informe> {
  const token = entorno.WHATSAPP_ACCESS_TOKEN;
  if (!token || token.trim().length === 0) throw new UsoIncorrectoError("falta WHATSAPP_ACCESS_TOKEN en el entorno (exportalo en tu terminal; el script no lee archivos de secretos)");
  const deEntorno = entorno.WHATSAPP_GRAPH_API_VERSION?.trim();
  const version = opts.version ?? (esVersionGraphValida(deEntorno) ? deEntorno : undefined);
  const wabas = opts.wabas.length > 0 ? opts.wabas : (entorno.WHATSAPP_WABA_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (opts.numeros.length === 0 && wabas.length === 0) throw new UsoIncorrectoError("indica al menos un --numero o una --waba (o WHATSAPP_WABA_IDS)");
  const appId = entorno.META_APP_ID?.trim() || null;
  const reader = new MetaGraphWhatsAppReader({ accessToken: token, ...(version ? { apiVersion: version } : {}), ...(fetchImpl ? { fetchImpl } : {}) });

  const numeros: InformeNumero[] = [];
  const informeWabas: InformeWaba[] = [];
  const motivosGlobales: Motivo[] = [];
  try {
    for (const { id, etiqueta } of opts.numeros) numeros.push(await revisarNumero(reader, id, etiqueta, opts.esperaCoexistencia));
    for (const wabaId of wabas) informeWabas.push(await revisarWaba(reader, wabaId, appId));
  } catch (err) {
    if (!(err instanceof TokenInvalidoCorta)) throw err;
    motivosGlobales.push({ nivel: "rojo", texto: "token invalido, vencido o revocado (Graph 190/401): se corta la verificacion" });
  }
  if (wabas.length === 0 && motivosGlobales.length === 0) {
    motivosGlobales.push({ nivel: "amarillo", texto: "sin --waba: no se revisaron plantillas, limite de mensajeria ni apps suscritas" });
  }

  const todos = [...motivosGlobales, ...numeros.flatMap((n) => n.motivos), ...informeWabas.flatMap((w) => w.motivos)];
  const semaforo = peor(todos);
  return { version_graph: reader.version, semaforo, codigo: ORDEN[semaforo] as 0 | 1 | 2, numeros, wabas: informeWabas, motivos: todos };
}

const ICONO: Record<Semaforo, string> = { verde: "VERDE", amarillo: "AMARILLO", rojo: "ROJO" };

function tabla(filas: readonly (readonly string[])[]): string {
  const anchos = filas[0]!.map((_, c) => Math.max(...filas.map((f) => (f[c] ?? "").length)));
  return filas.map((f) => f.map((celda, c) => celda.padEnd(anchos[c]!)).join("  ").trimEnd()).join("\n");
}

export function formatearTexto(informe: Informe): string {
  const salida: string[] = [`verificar-meta-whatsapp (solo lectura) - Graph ${informe.version_graph}`, ""];
  if (informe.numeros.length > 0) {
    salida.push("NUMEROS");
    salida.push(
      tabla([
        ["etiqueta", "numero", "nombre verificado", "calidad", "platform_type", "on_biz_app", "throughput", "estado", "estado nombre", "semaforo"],
        ...informe.numeros.map((n) => [
          n.etiqueta,
          n.display_phone_number ?? "-",
          n.verified_name ?? "-",
          n.quality_rating ?? "-",
          n.platform_type ?? "-",
          n.is_on_biz_app === null ? "-" : String(n.is_on_biz_app),
          n.throughput ?? "-",
          n.status ?? "-",
          n.name_status ?? "-",
          ICONO[n.semaforo],
        ]),
      ]),
    );
    salida.push("");
  }
  for (const w of informe.wabas) {
    salida.push(`WABA ${w.waba_id}${w.nombre ? ` (${w.nombre})` : ""}${w.leida ? "" : " - no se pudo leer"}`);
    salida.push(`  limite de mensajeria: ${w.limite_mensajeria ?? "no informado"}`);
    const estados = Object.entries(w.plantillas_por_estado).map(([estado, n]) => `${estado}=${n}`).join(", ");
    salida.push(`  plantillas: ${w.plantillas_total === null ? "no se pudieron leer" : `${w.plantillas_total} (${estados || "ninguna"})`}`);
    if (w.plantillas_total !== null) {
      salida.push("  esperadas por el producto:");
      for (const e of w.plantillas_esperadas) salida.push(`    ${e.estado === "APPROVED" ? "ok     " : "REVISAR"} ${e.nombre}: ${e.estado}`);
    }
    salida.push(`  app suscrita: ${w.app_suscrita === null ? "no comprobado" : w.app_suscrita ? "si" : "NO"} (${w.apps_suscritas.length} app(s) en subscribed_apps)`);
    salida.push("");
  }
  if (informe.motivos.length > 0) {
    salida.push("MOTIVOS");
    for (const m of informe.motivos) salida.push(`  [${ICONO[m.nivel]}] ${m.texto}`);
    salida.push("");
  }
  salida.push(`SEMAFORO: ${ICONO[informe.semaforo]} (codigo de salida ${informe.codigo})`);
  return salida.join("\n");
}

export interface ResultadoEjecucion {
  readonly codigo: number;
  readonly informe: Informe | null;
}

/** Punto de entrada testeable: no toca `process`. `escribir` recibe lineas ya sin rastro del token. */
export async function ejecutar(argv: readonly string[], entorno: Readonly<Record<string, string | undefined>>, escribir: (texto: string) => void, fetchImpl?: typeof fetch): Promise<ResultadoEjecucion> {
  const token = entorno.WHATSAPP_ACCESS_TOKEN;
  const salida = (texto: string): void => escribir(redactarSecretos(texto, token));
  try {
    const opts = parseArgs(argv);
    if (opts.ayuda) {
      salida(AYUDA);
      return { codigo: 0, informe: null };
    }
    const informe = await verificar(opts, entorno, fetchImpl);
    salida(opts.json ? JSON.stringify(informe, null, 2) : formatearTexto(informe));
    return { codigo: informe.codigo, informe };
  } catch (err) {
    if (err instanceof UsoIncorrectoError) {
      salida(`${err.message}\n\n${AYUDA}`);
      return { codigo: 3, informe: null };
    }
    salida(`error inesperado: ${textoError(err)}`);
    return { codigo: 3, informe: null };
  }
}

function esModuloPrincipal(): boolean {
  const entrada = process.argv[1];
  if (!entrada) return false;
  try {
    return import.meta.url === pathToFileURL(entrada).href;
  } catch {
    return false;
  }
}

if (esModuloPrincipal()) {
  const { codigo } = await ejecutar(process.argv.slice(2), process.env, (texto) => process.stdout.write(`${texto}\n`));
  process.exit(codigo);
}
