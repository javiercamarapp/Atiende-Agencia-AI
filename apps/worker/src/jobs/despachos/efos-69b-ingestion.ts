// runEfos69bIngestion -- ingesta mensual de la lista 69-B del SAT (D-04).
//
// SIN llamadas reales al SAT: la fuente es un ADAPTADOR (`Efos69bSource`). Hoy solo existen
// dos: la subida manual por la ruta interna (`POST /internal/despachos/efos-69b/ingestar`,
// que envuelve el archivo recibido) y `FixtureEfos69bSource` (pruebas). Una descarga
// automática del archivo público del SAT es un adaptador futuro que se registra aquí sin
// tocar el parser ni la base (ver README del job); NO se agenda ningún cron en vercel.json.
//
// Una sola transacción de sistema (la ingesta es de UNA edición global, no por unidad) y
// falla ENTERA si el archivo es inválido: nunca se ingiere una lista a medias.
import { parsearListado69B, esPeriodoEfosValido, Efos69bFormatoError } from "@atiende/domain-despachos";
import type { DespachosRepository, EfosIngestaResultado, EfosFilaDescartada } from "@atiende/domain-despachos";

export interface Efos69bSource {
  /** Texto ya decodificado del CSV público de la edición `periodo` (YYYY-MM). */
  obtenerListado(periodo: string): Promise<string>;
}

/** Fuente fija en memoria: pruebas y demos sin red. */
export class FixtureEfos69bSource implements Efos69bSource {
  constructor(private readonly textos: Readonly<Record<string, string>>) {}
  async obtenerListado(periodo: string): Promise<string> {
    const t = this.textos[periodo];
    if (t === undefined) throw new Error(`FixtureEfos69bSource: sin fixture para ${periodo}`);
    return t;
  }
}

export type WithDespachosRepoSistema = <T>(fn: (repo: DespachosRepository) => Promise<T>) => Promise<T>;

export interface Efos69bIngestionResult {
  readonly periodo: string;
  readonly resultado: EfosIngestaResultado;
  readonly filas: number;
  readonly descartadas: readonly EfosFilaDescartada[];
  readonly fuenteSha256: string;
}

export async function runEfos69bIngestion(withRepo: WithDespachosRepoSistema, source: Efos69bSource, periodo: string): Promise<Efos69bIngestionResult> {
  if (!esPeriodoEfosValido(periodo)) throw new Efos69bFormatoError("periodo: se esperaba el formato YYYY-MM.");
  const parseado = parsearListado69B(await source.obtenerListado(periodo));
  const resultado = await withRepo((repo) => repo.ingestarListaEfos(periodo, parseado.fuenteSha256, parseado.filas));
  return { periodo, resultado, filas: parseado.filas.length, descartadas: parseado.descartadas, fuenteSha256: parseado.fuenteSha256 };
}
