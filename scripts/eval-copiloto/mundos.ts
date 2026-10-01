// Mundos del arnes: por vertical, el alcance fijado por el servidor, el catalogo REAL de produccion y como abrirlo,
// ya sea contra Postgres sembrado (sesion RLS del usuario, como en la API) o contra la REPETICION congelada (CI sin base).
import { openManagedPostgres, type ManagedPostgresEngine } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { DataChatCatalog, DataChatScope, DataChatTool, DataChatToolResult } from "@atiende/agent-core/data-chat";
import type { ArchivoCongelado, MundoVertical } from "@atiende/agent-core/data-chat/evals";
import { buildCitasDataChatCatalog, PostgresCitasDataChatReader } from "@atiende/domain-citas";
import { buildDespachosDataChatCatalog, PostgresDespachosDataChatReader } from "@atiende/domain-despachos";
import { buildHotelesDataChatCatalog, PostgresHotelesDataChatReader } from "@atiende/domain-hoteles";
import { buildLicitacionesDataChatCatalog, PostgresLicitacionesDataChatReader } from "@atiende/domain-licitaciones";
import { buildRentasDataChatCatalog, PostgresRentasDataChatReader } from "@atiende/domain-rentas";
import { buildRestaurantesDataChatCatalog, PostgresRestaurantesDataChatReader } from "@atiende/domain-restaurantes";

/** Instante fijo del arnes: miercoles 30-sep-2026 12:00 hora de Merida (UTC-6). Las semillas viven alrededor de esa fecha. */
export const AHORA_EVAL = new Date("2026-09-30T18:00:00.000Z");
export const ZONA_EVAL = "America/Merida";

export const VERTICALES_EVAL = ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"] as const;
export type VerticalEval = (typeof VERTICALES_EVAL)[number];

interface ConfigVertical {
  readonly organizationId: string;
  readonly userId: string;
  readonly verticalRole: string;
  readonly conSesion: (db: TenantDbSession) => DataChatCatalog;
  /** Catalogo con un lector que nunca se usa: solo para leer nombres, descripciones y esquemas de parametros. */
  readonly sinBase: () => DataChatCatalog;
}

const lectorVacio = (): never => new Proxy({}, { get: () => async () => [] }) as never;

export const CONFIG: Readonly<Record<VerticalEval, ConfigVertical>> = {
  restaurantes: {
    organizationId: "00000000-0000-0000-0000-00000000d001",
    userId: "00000000-0000-0000-0000-000000000041",
    verticalRole: "owner",
    conSesion: (db) => buildRestaurantesDataChatCatalog(new PostgresRestaurantesDataChatReader(db)),
    sinBase: () => buildRestaurantesDataChatCatalog(lectorVacio()),
  },
  hoteles: {
    organizationId: "00000000-0000-0000-0000-00000000d101",
    userId: "00000000-0000-0000-0000-000000000141",
    verticalRole: "owner",
    conSesion: (db) => buildHotelesDataChatCatalog(new PostgresHotelesDataChatReader(db)),
    sinBase: () => buildHotelesDataChatCatalog(lectorVacio()),
  },
  rentas: {
    organizationId: "00000000-0000-0000-0000-00000000d201",
    userId: "00000000-0000-0000-0000-000000000241",
    verticalRole: "admin_gestora",
    conSesion: (db) => buildRentasDataChatCatalog(new PostgresRentasDataChatReader(db)),
    sinBase: () => buildRentasDataChatCatalog(lectorVacio()),
  },
  despachos: {
    organizationId: "00000000-0000-0000-0000-00000000d301",
    userId: "00000000-0000-0000-0000-000000000061",
    verticalRole: "admin",
    conSesion: (db) => buildDespachosDataChatCatalog(new PostgresDespachosDataChatReader(db)),
    sinBase: () => buildDespachosDataChatCatalog(lectorVacio()),
  },
  licitaciones: {
    organizationId: "00000000-0000-0000-0000-00000000d401",
    userId: "00000000-0000-0000-0000-000000000071",
    verticalRole: "owner",
    conSesion: (db) => buildLicitacionesDataChatCatalog(new PostgresLicitacionesDataChatReader(db)),
    sinBase: () => buildLicitacionesDataChatCatalog(lectorVacio()),
  },
  citas: {
    organizationId: "00000000-0000-0000-0000-000000c10100",
    userId: "00000000-0000-0000-0000-000000c11001",
    verticalRole: "owner",
    conSesion: (db) => buildCitasDataChatCatalog(new PostgresCitasDataChatReader(db)),
    sinBase: () => buildCitasDataChatCatalog(lectorVacio()),
  },
};

/** Valores por omision de parametros opcionales (leidos del codigo de los catalogos): mandarlos explicitos == omitirlos. */
export const POR_OMISION: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
  productos_mas_vendidos: { ordenar_por: "cantidad", limite: 10 },
  horas_pico: { limite: 5 },
  convocatorias_abiertas: { limite: 20 },
  renovaciones: { dentro_de_dias: 90 },
  tareas_pendientes: { tipo: "limpieza" },
  ocupacion: { agrupar_por: "profesional" },
};

export function alcanceDe(v: VerticalEval): DataChatScope {
  const c = CONFIG[v];
  return { organizationId: c.organizationId, userId: c.userId, vertical: v, verticalRole: c.verticalRole, allowedPropertyIds: null, timezone: ZONA_EVAL };
}

export function esVertical(v: string): v is VerticalEval {
  return (VERTICALES_EVAL as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Postgres sembrado
// ---------------------------------------------------------------------------------------------

export function abrirMotor(url: string): ManagedPostgresEngine {
  return openManagedPostgres({ connectionString: url, ssl: false, poolMax: 8, statementTimeoutMs: 20_000 });
}

/** Mantiene abierta UNA transaccion RLS del usuario (como `dbSession` en la API) hasta que se llame a `cerrar`. */
export function abrirSesion(engine: ManagedPostgresEngine, userId: string): Promise<{ session: TenantDbSession; cerrar(): Promise<void> }> {
  return new Promise((resolverApertura, rechazarApertura) => {
    let liberar!: () => void;
    const retener = new Promise<void>((r) => {
      liberar = r;
    });
    const trabajo = engine
      .withAppSession({ userId }, async (session) => {
        resolverApertura({
          session,
          async cerrar() {
            liberar();
            await trabajo.catch(() => undefined);
          },
        });
        await retener;
      })
      .catch((err) => {
        rechazarApertura(err);
        throw err;
      });
    trabajo.catch(() => undefined);
  });
}

export function mundoPostgres(vertical: VerticalEval, engine: ManagedPostgresEngine): MundoVertical {
  const cfg = CONFIG[vertical];
  return {
    vertical,
    scope: alcanceDe(vertical),
    now: AHORA_EVAL,
    porOmision: POR_OMISION,
    async abrir() {
      const { session, cerrar } = await abrirSesion(engine, cfg.userId);
      return { catalog: cfg.conSesion(session), cerrar };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repeticion congelada (CI sin base): las herramientas devuelven lo que la referencia congelo.
// ---------------------------------------------------------------------------------------------

export function claveLlamada(tool: string, args: Readonly<Record<string, string | number | undefined>>): string {
  const partes = Object.keys(args)
    .filter((k) => args[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`);
  return `${tool}?${partes.join("&")}`;
}

export function mundoRepeticion(vertical: VerticalEval, congelado: ArchivoCongelado): MundoVertical {
  const base = CONFIG[vertical].sinBase();
  const resultados = new Map<string, DataChatToolResult>();
  for (const refs of Object.values(congelado.referencias)) for (const r of refs) resultados.set(claveLlamada(r.tool, r.args), r.result);
  const tools: DataChatTool[] = base.tools.map((t) => ({
    ...t,
    async run(_ctx, args) {
      const hit = resultados.get(claveLlamada(t.name, args));
      if (hit) return hit;
      return { status: "error", message: "Consulta sin referencia congelada (solo modo guionado).", source: t.label, scopeLabel: "", columns: [], rows: [] };
    },
  }));
  const catalog: DataChatCatalog = { ...base, tools, describeScope: async () => congelado.scopeLine };
  return { vertical, scope: alcanceDe(vertical), now: new Date(congelado.now), porOmision: POR_OMISION, async abrir() { return { catalog, async cerrar() {} }; } };
}
