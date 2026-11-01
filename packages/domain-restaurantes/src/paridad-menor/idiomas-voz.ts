// F4c (2) -- SELECTOR DE IDIOMAS del agente de VOZ, por sucursal. Config validada contra una lista cerrada de 32 idiomas (la misma cantidad del original).
// El idioma NO cambia ninguna regla: solo COMO habla el agente. Con la config por omision (solo es-MX, sin deteccion) `bloqueIdiomasVoz` devuelve "" y la instruccion de la
// llamada queda BYTE A BYTE igual que antes (huellas en tests/paridad-menor-golden-prompts.spec.ts): PM no cambia mientras nadie elija otro idioma.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { ParidadNoDisponibleError, ParidadRechazadaError, codigoPg, esBaseSinMigrar, esErrorEscrituraConocido, iso } from "./comun.ts";

export const IDIOMAS_VOZ = Object.freeze([
  { codigo: "es-MX", nombre: "Español (México)" },
  { codigo: "es-ES", nombre: "Español (España)" },
  { codigo: "es-US", nombre: "Español (Estados Unidos)" },
  { codigo: "en-US", nombre: "Inglés (Estados Unidos)" },
  { codigo: "en-GB", nombre: "Inglés (Reino Unido)" },
  { codigo: "fr-FR", nombre: "Francés" },
  { codigo: "de-DE", nombre: "Alemán" },
  { codigo: "it-IT", nombre: "Italiano" },
  { codigo: "pt-BR", nombre: "Portugués (Brasil)" },
  { codigo: "pt-PT", nombre: "Portugués (Portugal)" },
  { codigo: "nl-NL", nombre: "Neerlandés" },
  { codigo: "pl-PL", nombre: "Polaco" },
  { codigo: "ru-RU", nombre: "Ruso" },
  { codigo: "uk-UA", nombre: "Ucraniano" },
  { codigo: "tr-TR", nombre: "Turco" },
  { codigo: "ar-XA", nombre: "Árabe" },
  { codigo: "he-IL", nombre: "Hebreo" },
  { codigo: "hi-IN", nombre: "Hindi" },
  { codigo: "bn-IN", nombre: "Bengalí" },
  { codigo: "ta-IN", nombre: "Tamil" },
  { codigo: "id-ID", nombre: "Indonesio" },
  { codigo: "ms-MY", nombre: "Malayo" },
  { codigo: "vi-VN", nombre: "Vietnamita" },
  { codigo: "th-TH", nombre: "Tailandés" },
  { codigo: "zh-CN", nombre: "Chino (mandarín)" },
  { codigo: "ja-JP", nombre: "Japonés" },
  { codigo: "ko-KR", nombre: "Coreano" },
  { codigo: "sv-SE", nombre: "Sueco" },
  { codigo: "da-DK", nombre: "Danés" },
  { codigo: "fi-FI", nombre: "Finés" },
  { codigo: "el-GR", nombre: "Griego" },
  { codigo: "cs-CZ", nombre: "Checo" },
] as const);

export type CodigoIdiomaVoz = (typeof IDIOMAS_VOZ)[number]["codigo"];
export const IDIOMA_VOZ_POR_OMISION: CodigoIdiomaVoz = "es-MX";
export const IDIOMAS_ADICIONALES_MAX = 4;

export interface ConfigIdiomasVoz {
  readonly principal: CodigoIdiomaVoz;
  readonly adicionales: readonly CodigoIdiomaVoz[];
  /** El agente contesta en el idioma en que le hable el cliente, dentro de los permitidos. */
  readonly deteccionAutomatica: boolean;
}

export const CONFIG_IDIOMAS_VOZ_POR_OMISION: ConfigIdiomasVoz = Object.freeze({ principal: IDIOMA_VOZ_POR_OMISION, adicionales: Object.freeze([]) as readonly CodigoIdiomaVoz[], deteccionAutomatica: false });

export function esCodigoIdiomaVoz(v: unknown): v is CodigoIdiomaVoz {
  return typeof v === "string" && IDIOMAS_VOZ.some((i) => i.codigo === v);
}

export function nombreIdiomaVoz(codigo: CodigoIdiomaVoz): string {
  return IDIOMAS_VOZ.find((i) => i.codigo === codigo)?.nombre ?? codigo;
}

export class IdiomasVozInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdiomasVozInvalidosError";
  }
}

/** Valida el cuerpo del PUT. Todos los campos son obligatorios (se guarda completo); `principal` de la lista, `adicionales` sin repetidos ni el principal, maximo 4. */
export function validarConfigIdiomasVoz(raw: { readonly principal?: unknown; readonly adicionales?: unknown; readonly deteccionAutomatica?: unknown }): ConfigIdiomasVoz {
  if (!esCodigoIdiomaVoz(raw.principal)) throw new IdiomasVozInvalidosError("principal: no esta en la lista de idiomas permitidos.");
  if (!Array.isArray(raw.adicionales)) throw new IdiomasVozInvalidosError("adicionales: se esperaba una lista (puede ir vacia).");
  if (raw.adicionales.length > IDIOMAS_ADICIONALES_MAX) throw new IdiomasVozInvalidosError(`adicionales: maximo ${IDIOMAS_ADICIONALES_MAX} idiomas.`);
  const adicionales: CodigoIdiomaVoz[] = [];
  for (const a of raw.adicionales as readonly unknown[]) {
    if (!esCodigoIdiomaVoz(a)) throw new IdiomasVozInvalidosError("adicionales: un idioma no esta en la lista permitida.");
    if (a === raw.principal) throw new IdiomasVozInvalidosError("adicionales: no repitas el idioma principal.");
    if (adicionales.includes(a)) throw new IdiomasVozInvalidosError("adicionales: hay un idioma repetido.");
    adicionales.push(a);
  }
  if (typeof raw.deteccionAutomatica !== "boolean") throw new IdiomasVozInvalidosError("deteccionAutomatica: true o false.");
  if (raw.deteccionAutomatica && adicionales.length === 0) throw new IdiomasVozInvalidosError("deteccionAutomatica: elige al menos un idioma adicional para detectar.");
  return { principal: raw.principal, adicionales, deteccionAutomatica: raw.deteccionAutomatica };
}

export function esConfigIdiomasPorOmision(c: ConfigIdiomasVoz | null | undefined): boolean {
  return !c || (c.principal === IDIOMA_VOZ_POR_OMISION && c.adicionales.length === 0 && !c.deteccionAutomatica);
}

/** Bloque de la instruccion de voz; cadena vacia con la config por omision (la instruccion no cambia ni un byte). Solo nombres de idioma de la lista cerrada: ningun texto del usuario. */
export function bloqueIdiomasVoz(c: ConfigIdiomasVoz | null | undefined): string {
  if (!c || esConfigIdiomasPorOmision(c)) return "";
  const lineas = ["# IDIOMAS DE LA LLAMADA", `- Idioma principal: ${nombreIdiomaVoz(c.principal)} (${c.principal}). Salude y atienda en ese idioma.`];
  if (c.adicionales.length > 0) {
    const lista = c.adicionales.map((a) => `${nombreIdiomaVoz(a)} (${a})`).join(", ");
    lineas.push(
      c.deteccionAutomatica
        ? `- Idiomas permitidos ademas: ${lista}. Si el cliente le habla en uno de ellos, conteste en ese idioma durante el resto de la llamada; con cualquier otro idioma siga en el principal.`
        : `- Idiomas permitidos ademas: ${lista}. Cambie a uno de ellos solo si el cliente se lo pide.`,
    );
  } else {
    lineas.push("- No cambie de idioma aunque el cliente lo haga: dele las gracias y siga en el principal.");
  }
  lineas.push("- El idioma solo cambia COMO habla: NO cambia ninguna regla de arriba (precios y totales de las herramientas, horarios, escalacion, seguridad). Los nombres de productos y sucursales se dicen tal cual, y el saludo inicial indicado arriba se dice exactamente como esta.");
  return lineas.join("\n");
}

/** Anexa el bloque al FINAL de la instruccion; con la config por omision devuelve la misma cadena. */
export function instruccionConIdiomas(instruccion: string, c: ConfigIdiomasVoz | null | undefined): string {
  const bloque = bloqueIdiomasVoz(c);
  return bloque === "" ? instruccion : `${instruccion}\n\n${bloque}`;
}

export interface LecturaIdiomasVoz {
  /** false = la base todavia no tiene la migracion 181 (se devuelve la config por omision). */
  readonly disponible: boolean;
  readonly configurado: boolean;
  readonly valor: ConfigIdiomasVoz;
  readonly actualizadoEn: string | null;
}

export const LECTURA_IDIOMAS_POR_OMISION: LecturaIdiomasVoz = Object.freeze({ disponible: false, configurado: false, valor: CONFIG_IDIOMAS_VOZ_POR_OMISION, actualizadoEn: null });

export interface IdiomasVozRepository {
  leer(propertyId: string): Promise<LecturaIdiomasVoz>;
  guardar(organizationId: string, propertyId: string, actorUserId: string, config: ConfigIdiomasVoz): Promise<LecturaIdiomasVoz>;
}

interface FilaIdiomas {
  idioma_principal: string;
  idiomas_adicionales: readonly string[];
  deteccion_automatica: boolean;
  updated_at: Date | string;
}

/** Una fila con un valor fuera de la lista (escrita directo en la base) cae a la config por omision: la llamada nunca se rompe por un idioma desconocido. */
export function idiomasDeFila(f: FilaIdiomas): ConfigIdiomasVoz {
  if (!esCodigoIdiomaVoz(f.idioma_principal)) return CONFIG_IDIOMAS_VOZ_POR_OMISION;
  const adicionales = (f.idiomas_adicionales ?? []).filter(esCodigoIdiomaVoz).filter((a) => a !== f.idioma_principal).slice(0, IDIOMAS_ADICIONALES_MAX);
  return { principal: f.idioma_principal, adicionales, deteccionAutomatica: f.deteccion_automatica === true && adicionales.length > 0 };
}

export class PostgresIdiomasVozRepository implements IdiomasVozRepository {
  constructor(private readonly db: TenantDbSession) {}

  async leer(propertyId: string): Promise<LecturaIdiomasVoz> {
    return runWithSavepointFallback<LecturaIdiomasVoz>({
      session: this.db,
      savepointName: "sp_voz_idiomas_read",
      primary: async () => {
        const { rows } = await this.db.query<FilaIdiomas>(`select idioma_principal, idiomas_adicionales, deteccion_automatica, updated_at from restaurantes.branch_voice_languages where property_id = $1;`, [propertyId]);
        const f = rows[0];
        return f ? { disponible: true, configurado: true, valor: idiomasDeFila(f), actualizadoEn: iso(f.updated_at) } : { disponible: true, configurado: false, valor: CONFIG_IDIOMAS_VOZ_POR_OMISION, actualizadoEn: null };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => LECTURA_IDIOMAS_POR_OMISION,
    });
  }

  async guardar(organizationId: string, propertyId: string, actorUserId: string, c: ConfigIdiomasVoz): Promise<LecturaIdiomasVoz> {
    return runWithSavepointFallback<LecturaIdiomasVoz>({
      session: this.db,
      savepointName: "sp_voz_idiomas_write",
      primary: async () => {
        const { rows } = await this.db.query<FilaIdiomas>(
          `insert into restaurantes.branch_voice_languages (property_id, organization_id, idioma_principal, idiomas_adicionales, deteccion_automatica, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (property_id) do update set
             idioma_principal = excluded.idioma_principal, idiomas_adicionales = excluded.idiomas_adicionales,
             deteccion_automatica = excluded.deteccion_automatica, updated_by = excluded.updated_by, updated_at = excluded.updated_at
           where restaurantes.branch_voice_languages.organization_id = excluded.organization_id
           returning idioma_principal, idiomas_adicionales, deteccion_automatica, updated_at;`,
          [propertyId, organizationId, c.principal, [...c.adicionales], c.deteccionAutomatica, actorUserId],
        );
        const f = rows[0];
        // Sin fila devuelta = la sucursal ya tenia config de OTRA organizacion (cross-tenant): rechazo, nunca un exito falso.
        if (!f) throw new ParidadRechazadaError("La sucursal no pertenece a esta organizacion.");
        return { disponible: true, configurado: true, valor: idiomasDeFila(f), actualizadoEn: iso(f.updated_at) };
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: async (err) => {
        if (codigoPg(err) === "42501") throw new ParidadRechazadaError("No tienes permiso para cambiar los idiomas de esta sucursal.");
        throw new ParidadNoDisponibleError("Los idiomas de voz requieren aplicar la migracion 181; no se cambio nada.");
      },
    });
  }
}

/** Adaptador en memoria para pruebas. `migrada = false` simula la base sin la 181. */
export class InMemoryIdiomasVozRepository implements IdiomasVozRepository {
  migrada = true;
  rechazar = false;
  private readonly filas = new Map<string, { organizationId: string; valor: ConfigIdiomasVoz; actualizadoEn: string }>();
  readonly escrituras: { organizationId: string; propertyId: string; actorUserId: string; config: ConfigIdiomasVoz }[] = [];

  async leer(propertyId: string): Promise<LecturaIdiomasVoz> {
    if (!this.migrada) return LECTURA_IDIOMAS_POR_OMISION;
    const f = this.filas.get(propertyId);
    return f ? { disponible: true, configurado: true, valor: f.valor, actualizadoEn: f.actualizadoEn } : { disponible: true, configurado: false, valor: CONFIG_IDIOMAS_VOZ_POR_OMISION, actualizadoEn: null };
  }

  async guardar(organizationId: string, propertyId: string, actorUserId: string, config: ConfigIdiomasVoz): Promise<LecturaIdiomasVoz> {
    if (!this.migrada) throw new ParidadNoDisponibleError("Los idiomas de voz requieren aplicar la migracion 181; no se cambio nada.");
    if (this.rechazar) throw new ParidadRechazadaError("No tienes permiso para cambiar los idiomas de esta sucursal.");
    const previa = this.filas.get(propertyId);
    if (previa && previa.organizationId !== organizationId) throw new ParidadRechazadaError("La sucursal no pertenece a esta organizacion.");
    const actualizadoEn = new Date().toISOString();
    this.filas.set(propertyId, { organizationId, valor: config, actualizadoEn });
    this.escrituras.push({ organizationId, propertyId, actorUserId, config });
    return { disponible: true, configurado: true, valor: config, actualizadoEn };
  }
}
