// Mundo de pruebas del worker: la API REAL de Atiende en proceso (Hono + repositorios en memoria, sin red) con el restaurante sembrado del simulador
// de voz (Los Taquitos de PM: menu, sucursales, colonias, politica de $200). El `fetch` del worker se apunta a `app.request`.
import type { VozCerrarConversacionInput } from "@atiende/domain-restaurantes";
import { InMemoryVozKpiRepository, InMemoryVozLlamadaRepository, InMemoryVozRepository, InMemoryPrivacidadRepository } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, MapaProductoCodigo, crearResolverSucursalPos } from "@atiende/domain-restaurantes/softrestaurant";
import type { SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { MENSAJE_IDS } from "@atiende/voice-core";
import type { MensajeId } from "@atiende/voice-core";
import { buildApp } from "../../../api/src/app.ts";
import type { AppDeps } from "../../../api/src/deps.ts";
import { buildTestDeps } from "../../../api/tests/fixtures.ts";
import { crearMundoVoz, BRANCH_SLUG_PRINCIPAL } from "../../../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";
import type { MundoVoz } from "../../../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";
import { ClienteApi } from "../../src/api-cliente.ts";
import { cargarConfig } from "../../src/config.ts";
import type { ConfigWorker } from "../../src/config.ts";
import type { AudioWav } from "../../src/audio/pcm.ts";
import type { DepsAtencion } from "../../src/llamada.ts";
import { tono } from "./audio.ts";

export const NUMERO_SUCURSAL = "+52 999 111 0001";
export const SECRETO_VOZ_PRUEBA = "test-voice-tool-secret";
export const INTERNAL_SECRET_PRUEBA = "test-internal-secret";

/** Repositorio de voz en memoria con el FK al pedido real: el pedido ya existe en el repositorio de restaurantes compartido (en Postgres lo valida la funcion SQL). */
class VozRepoConPedidosReales extends InMemoryVozRepository {
  override async cerrarConversacion(input: VozCerrarConversacionInput): Promise<boolean> {
    if (input.orderId) this.seedOrder(input.orderId, input.organizationId);
    return super.cerrarConversacion(input);
  }
}

/** Reloj manual: la llamada completa corre sin esperas reales. */
export class RelojManual {
  constructor(private ms = Date.parse("2026-03-10T18:00:00.000Z")) {}
  ahora = (): number => this.ms;
  avanzar(ms: number): void {
    this.ms += ms;
  }
}

/** Audios pregrabados de prueba: cada mensaje dura distinto (20 ms + 10 ms por indice) para saber CUAL sono. */
export function pregrabadosDePrueba(): ReadonlyMap<MensajeId, AudioWav> {
  return new Map(MENSAJE_IDS.map((id, i) => [id, { muestras: tono(8_000, 20 + i * 10, 300 + i * 20), hz: 8_000 }]));
}
export function mensajeQueSono(muestras: Int16Array, hz: number): MensajeId | null {
  const esperado = pregrabadosDePrueba();
  for (const [id, a] of esperado) if (a.hz === hz && a.muestras.length === muestras.length) return id;
  return null;
}

function falsoComoReal(fake: FakeSoftRestaurantAdapter): SoftRestaurantPort {
  return new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
}

export interface OpcionesMundoApi {
  readonly habilitado?: boolean;
  /** Gasto de voz del mes que ya trae la organizacion (micro-USD). */
  readonly gastoPrevioMicroUsd?: number;
  readonly envExtra?: Record<string, string>;
  /** Sobreescritura del tope mensual de la organizacion en la tabla DNIS (USD). */
  readonly topeMensualUsd?: number;
  readonly modoEntrada?: "desborde" | "total" | "prueba";
  /** Lineas propias de la sucursal que desvian al numero puente (`numerosSucursal` de la tabla DNIS). */
  readonly numerosSucursal?: readonly string[];
  /** `true` = la API no tiene el repositorio de voz (contexto 503). */
  readonly sinVozRepo?: boolean;
  /** `true` = la API no tiene el repositorio de privacidad (503 en apertura): el worker debe atender sin aviso y sin grabar. */
  readonly sinPrivacidad?: boolean;
}

export interface MundoApi {
  readonly mundo: MundoVoz;
  readonly voz: InMemoryVozRepository;
  readonly kpi: InMemoryVozKpiRepository;
  readonly llamadaRepo: InMemoryVozLlamadaRepository;
  readonly privacidad: InMemoryPrivacidadRepository;
  readonly srStore: InMemoryComandaOutboxStore;
  readonly deps: AppDeps;
  readonly app: ReturnType<typeof buildApp>;
  readonly config: ConfigWorker;
  readonly fetchFn: typeof fetch;
  readonly reloj: RelojManual;
  /** Peticiones que llegaron a la API (metodo + ruta), en orden. */
  readonly peticiones: string[];
  /** Cuerpos JSON de esas peticiones (ruta -> cuerpos), para afirmar lo que el worker mando. */
  readonly cuerpos: Map<string, unknown[]>;
  depsAtencion(extra: Partial<DepsAtencion> & Pick<DepsAtencion, "crearEscalera">): DepsAtencion;
}

export async function crearMundoApi(opts: OpcionesMundoApi = {}): Promise<MundoApi> {
  const base = await buildTestDeps();
  const mundo = crearMundoVoz();
  const voz = new VozRepoConPedidosReales();
  voz.seedProperty(mundo.propertyId, mundo.organizationId);
  await voz.upsertConfig(mundo.organizationId, mundo.propertyId, { habilitado: opts.habilitado ?? true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" });
  const kpi = new InMemoryVozKpiRepository();
  const llamadaRepo = new InMemoryVozLlamadaRepository();
  llamadaRepo.gastoPrevioMicroUsd = opts.gastoPrevioMicroUsd ?? 0;
  const privacidad = new InMemoryPrivacidadRepository();
  const srStore = new InMemoryComandaOutboxStore();
  srStore.ponerModo(mundo.organizationId, "sombra");
  const fake = new FakeSoftRestaurantAdapter();
  const deps: AppDeps = {
    ...base.deps,
    // Como en produccion con VOICE_REQUIRE_CALL_TOKEN=true: las herramientas SOLO aceptan el token por llamada (el secreto global ya no sirve).
    env: { ...base.deps.env, voiceRequireCallToken: true },
    restaurantesRepo: () => mundo.repo,
    ...(opts.sinVozRepo ? {} : { vozRepo: () => voz }),
    vozKpiRepo: () => kpi,
    vozLlamadaRepo: () => llamadaRepo,
    ...(opts.sinPrivacidad ? {} : { privacidadRepo: () => privacidad }),
    softRestaurantStore: () => srStore,
    softRestaurantPort: falsoComoReal(fake),
    softRestaurantMapeo: {
      resolverCodigos: new MapaProductoCodigo([{ productId: mundo.productos.bistec.id, codigo: "FAKE-001" }]),
      resolverSucursal: crearResolverSucursalPos({ [mundo.propertyId]: "T2" }),
    },
  };
  const app = buildApp(deps);
  const peticiones: string[] = [];
  const cuerpos = new Map<string, unknown[]>();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (typeof body === "string" && !headers.has("content-length")) headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
    peticiones.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (typeof body === "string") {
      try {
        cuerpos.set(url.pathname, [...(cuerpos.get(url.pathname) ?? []), JSON.parse(body)]);
      } catch {
        /* no es JSON */
      }
    }
    return app.request(url.pathname + url.search, { ...init, headers });
  };
  const env = {
    LIVEKIT_URL: "wss://ejemplo.livekit.invalid",
    LIVEKIT_API_KEY: "llave-livekit",
    LIVEKIT_API_SECRET: "secreto-livekit",
    ATIENDE_API_URL: "http://api.prueba.invalid",
    INTERNAL_SECRET: INTERNAL_SECRET_PRUEBA,
    GEMINI_API_KEY: "llave-gemini",
    VOICE_SECRET_FCO: SECRETO_VOZ_PRUEBA,
    VOICE_DNIS_MAP: JSON.stringify({ [NUMERO_SUCURSAL]: { orgSlug: "los-taquitos-de-pm", organizationId: mundo.organizationId, propertyId: mundo.propertyId, branchSlug: BRANCH_SLUG_PRINCIPAL, secretoEnv: "VOICE_SECRET_FCO", ...(opts.topeMensualUsd ? { topeMensualUsd: opts.topeMensualUsd } : {}), ...(opts.modoEntrada ? { modoEntrada: opts.modoEntrada } : {}), ...(opts.numerosSucursal ? { numerosSucursal: opts.numerosSucursal } : {}) } }),
    ...opts.envExtra,
  };
  const config = cargarConfig(env);
  if (config.estado !== "configurado") throw new Error(`mundo de prueba mal configurado: ${config.motivos.join(" | ")}`);
  const reloj = new RelojManual();
  return {
    mundo,
    voz,
    kpi,
    llamadaRepo,
    privacidad,
    srStore,
    deps,
    app,
    config,
    fetchFn,
    reloj,
    peticiones,
    cuerpos,
    depsAtencion: (extra) => ({
      config,
      pregrabados: pregrabadosDePrueba(),
      api: new ClienteApi({ baseUrl: config.apiBaseUrl, internalSecret: config.internalSecret, fetchFn }),
      log: () => undefined,
      fetchFn,
      ahora: reloj.ahora,
      programar: () => () => undefined,
      ...extra,
    }),
  };
}
