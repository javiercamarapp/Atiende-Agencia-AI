// Adaptador Postgres de `EncuestaRepository` (migracion 041). REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el
// codigo al instante y la 041 no se aplica sola. Cada consulta corre dentro de la transaccion UNICA del request (`withAppSession`): un error
// de Postgres la deja abortada (25P02), por eso usa `runWithSavepointFallback` y degrada a `disponible: false` (42883 funcion inexistente,
// 42P01 tabla, 42703 columna). `registrarEnvio` NO degrada: solo se llama tras `candidatas` (que ya confirmo la migracion) y dentro del
// savepoint por fila del barrido.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  ENCUESTA_CONFIG_DEFECTO,
  ENCUESTA_RESUMEN_VACIO,
  EncuestaNoDisponibleError,
  EncuestaValidationError,
} from "./encuesta.ts";
import type {
  EncuestaCandidata,
  EncuestaComentario,
  EncuestaConfig,
  EncuestaConfigEntrada,
  EncuestaLectura,
  EncuestaPublica,
  EncuestaRepository,
  EncuestaRespuestaEstado,
  EncuestaRespuestaResultado,
  EncuestaResumen,
} from "./encuesta.ts";

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresEncuestaRepository: las funciones restaurantes.encuesta_* todavia no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/041_encuesta_post_entrega.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

/** node-postgres entrega jsonb ya parseado; otros drivers pueden entregar texto. */
function asJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

const num = (v: unknown): number => Number(v);
const numNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface PromedioJson { enviadas: number | string; respondidas: number | string; promedio: number | string | null }
interface ResumenJson {
  global: PromedioJson & { distribucion: (number | string)[] };
  por_sucursal: (PromedioJson & { property_id: string; nombre: string })[];
  por_repartidor: (PromedioJson & { repartidor_id: string; nombre: string })[];
  recientes: { id: string; pedido: number | string | null; property_id: string; sucursal: string; calificacion: number | string; comentario: string | null; respondida_at: string; repartidor: string | null }[];
}

function mapPromedio(p: PromedioJson) {
  return { enviadas: num(p.enviadas), respondidas: num(p.respondidas), promedio: numNull(p.promedio) };
}

function mapResumen(j: ResumenJson): EncuestaResumen {
  const d = j.global.distribucion.map(num);
  const recientes: EncuestaComentario[] = j.recientes.map((r) => ({
    id: r.id,
    pedido: numNull(r.pedido),
    propertyId: r.property_id,
    sucursal: r.sucursal,
    calificacion: num(r.calificacion),
    comentario: r.comentario,
    respondidaAt: new Date(r.respondida_at).toISOString(),
    repartidor: r.repartidor,
  }));
  return {
    global: { ...mapPromedio(j.global), distribucion: [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0, d[4] ?? 0] },
    porSucursal: j.por_sucursal.map((s) => ({ propertyId: s.property_id, nombre: s.nombre, ...mapPromedio(s) })),
    porRepartidor: j.por_repartidor.map((r) => ({ repartidorId: r.repartidor_id, nombre: r.nombre, ...mapPromedio(r) })),
    recientes,
  };
}

interface ConfigJson { activa: boolean; espera_min: number | string; resenas_url: string | null; umbral_resena: number | string }
function mapConfig(j: ConfigJson): EncuestaConfig {
  return { activa: j.activa === true, esperaMin: num(j.espera_min), resenasUrl: j.resenas_url, umbralResena: num(j.umbral_resena) };
}

export class PostgresEncuestaRepository implements EncuestaRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async leer<T>(savepointName: string, vacio: T, consulta: () => Promise<T>): Promise<EncuestaLectura<T>> {
    return runWithSavepointFallback<EncuestaLectura<T>>({
      session: this.db,
      savepointName,
      primary: async () => ({ disponible: true, valor: await consulta() }),
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: vacio };
      },
    });
  }

  leerConfig(organizationId: string, propertyId: string): Promise<EncuestaLectura<EncuestaConfig>> {
    return this.leer("sp_encuesta_config_leer", ENCUESTA_CONFIG_DEFECTO, async () => {
      const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_config_leer($1, $2) as r;`, [organizationId, propertyId]);
      return mapConfig(asJson<ConfigJson>(rows[0]?.r) as ConfigJson);
    });
  }

  async guardarConfig(organizationId: string, propertyId: string, entrada: EncuestaConfigEntrada): Promise<EncuestaConfig> {
    return runWithSavepointFallback<EncuestaConfig>({
      session: this.db,
      savepointName: "sp_encuesta_config_guardar",
      primary: async () => {
        const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_config_guardar($1, $2, $3, $4, $5, $6) as r;`, [
          organizationId,
          propertyId,
          entrada.activa,
          entrada.esperaMin,
          entrada.resenasUrl,
          entrada.umbralResena,
        ]);
        return mapConfig(asJson<ConfigJson>(rows[0]?.r) as ConfigJson);
      },
      isRecoverable: (err) => esBaseSinMigrar(err) || code(err) === "22023",
      fallback: async (err) => {
        if (code(err) === "22023") throw new EncuestaValidationError(err instanceof Error ? err.message : "Valores fuera de rango.");
        advertirNoDisponible(err);
        throw new EncuestaNoDisponibleError();
      },
    });
  }

  resumen(organizationId: string, desde: string, hasta: string, propertyId: string | null): Promise<EncuestaLectura<EncuestaResumen>> {
    return this.leer("sp_encuesta_resumen", ENCUESTA_RESUMEN_VACIO, async () => {
      const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_resumen($1, $2::date, $3::date, $4) as r;`, [organizationId, desde, hasta, propertyId]);
      return mapResumen(asJson<ResumenJson>(rows[0]?.r) as ResumenJson);
    });
  }

  candidatas(organizationId: string | null, ahora: Date | null, limite: number): Promise<EncuestaLectura<readonly EncuestaCandidata[]>> {
    return this.leer<readonly EncuestaCandidata[]>("sp_encuesta_candidatas", [], async () => {
      const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_candidatas($1, $2::timestamptz, $3) as r;`, [
        organizationId,
        ahora ? ahora.toISOString() : null,
        limite,
      ]);
      const lista = asJson<{ order_id: string; organization_id: string; property_id: string; org_slug: string; sucursal: string; customer_name: string; customer_phone: string }[]>(rows[0]?.r) ?? [];
      return lista.map((c) => ({
        orderId: c.order_id,
        organizationId: c.organization_id,
        propertyId: c.property_id,
        orgSlug: c.org_slug,
        sucursal: c.sucursal,
        customerName: c.customer_name,
        customerPhone: c.customer_phone,
      }));
    });
  }

  async registrarEnvio(organizationId: string, orderId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ r: boolean }>(`select restaurantes.encuesta_registrar_envio($1, $2) as r;`, [organizationId, orderId]);
    return rows[0]?.r === true;
  }

  publica(organizationId: string, orderId: string): Promise<EncuestaLectura<EncuestaPublica | null>> {
    return this.leer<EncuestaPublica | null>("sp_encuesta_publica", null, async () => {
      const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_publica($1, $2) as r;`, [organizationId, orderId]);
      const j = asJson<{ sucursal: string; respondida: boolean; calificacion: number | string | null; resenas_url: string | null }>(rows[0]?.r);
      if (!j) return null;
      return { sucursal: j.sucursal, respondida: j.respondida === true, calificacion: numNull(j.calificacion), resenasUrl: j.resenas_url };
    });
  }

  responder(organizationId: string, orderId: string, calificacion: number, comentario: string | null): Promise<EncuestaLectura<EncuestaRespuestaResultado | null>> {
    return this.leer<EncuestaRespuestaResultado | null>("sp_encuesta_responder", null, async () => {
      const { rows } = await this.db.query<{ r: unknown }>(`select restaurantes.encuesta_responder($1, $2, $3, $4) as r;`, [organizationId, orderId, calificacion, comentario]);
      const j = asJson<{ estado: EncuestaRespuestaEstado; property_id?: string; calificacion?: number | string | null; resenas_url?: string | null }>(rows[0]?.r);
      if (!j) return null;
      return { estado: j.estado, propertyId: j.property_id ?? null, calificacion: numNull(j.calificacion), resenasUrl: j.resenas_url ?? null };
    });
  }
}
