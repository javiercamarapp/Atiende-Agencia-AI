// Resolutor de credenciales de Meta por numero (migracion 0090), con cache por instancia.
//
// Lee TODAS las credenciales activas de una vez (core.whatsapp_meta_credenciales_para_sistema, sesion de sistema) y las descifra en
// memoria; son pocas (una por app de Meta). La cache dura `ttlMs` (60 s por omision) y las rutas del superadmin la invalidan al
// escribir; otras instancias serverless ven el cambio en <= ttl. Un error de lectura NO se cachea: el siguiente llamado reintenta.
// Una fila que no se puede descifrar (llave rotada o sobre danado) se ignora con un aviso SIN datos sensibles y su numero cae a la
// plataforma; nunca tumba a las demas.
import { aadCredencialMeta, type CifradorCredencialesMeta } from "./cifrado.ts";
import { verificarFirmaConCandidatos, verifyTokenEnHashes } from "./firma.ts";

/** Forma de cada fila de core.whatsapp_meta_credenciales_para_sistema(). */
export interface FilaCredencialSistema {
  readonly id: string;
  readonly organization_id: string;
  readonly app_id: string;
  readonly waba_id: string;
  readonly app_secret_cifrado: string;
  readonly access_token_cifrado: string;
  readonly verify_token_hash: string | null;
  readonly phone_number_ids: readonly string[];
}

export interface CredencialMeta {
  readonly id: string;
  readonly organizationId: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly appSecret: string;
  readonly accessToken: string;
  readonly verifyTokenHash: string | null;
  readonly phoneNumberIds: readonly string[];
}

export interface ResolutorCredencialesMeta {
  /** Credencial activa asignada al numero, o `null` (el numero usa la plataforma). Lanza si no se pudo leer la fuente. */
  credencialDeNumero(phoneNumberId: string): Promise<CredencialMeta | null>;
  /** Todas las credenciales activas descifrables. Lanza si no se pudo leer la fuente. */
  todas(): Promise<readonly CredencialMeta[]>;
  /** `true` si el token es el verify token propio de alguna credencial activa. Un fallo de lectura cuenta como `false`. */
  verifyTokenValido(token: string): Promise<boolean>;
  invalidar(): void;
}

export interface OpcionesResolutorCredencialesMeta {
  readonly leer: () => Promise<readonly FilaCredencialSistema[]>;
  readonly cifrador: CifradorCredencialesMeta;
  readonly ttlMs?: number;
  readonly ahoraMs?: () => number;
  /** Aviso de una fila ignorada (solo el id de la credencial). */
  readonly avisar?: (credencialId: string) => void;
}

const TTL_POR_OMISION_MS = 60_000;

export function crearResolutorCredencialesMeta(opts: OpcionesResolutorCredencialesMeta): ResolutorCredencialesMeta {
  const ttl = opts.ttlMs ?? TTL_POR_OMISION_MS;
  const ahora = opts.ahoraMs ?? Date.now;
  const avisar =
    opts.avisar ??
    ((credencialId: string) =>
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          evento: "whatsapp_meta_credencial_ilegible",
          credencialId,
        }),
      ));
  let cache: {
    readonly hasta: number;
    readonly credenciales: readonly CredencialMeta[];
    readonly porNumero: ReadonlyMap<string, CredencialMeta>;
  } | null = null;
  let enCurso: Promise<NonNullable<typeof cache>> | null = null;
  let generacion = 0;

  function descifrar(f: FilaCredencialSistema): CredencialMeta | null {
    try {
      return {
        id: f.id,
        organizationId: f.organization_id,
        appId: f.app_id,
        wabaId: f.waba_id,
        appSecret: opts.cifrador.descifrar(f.app_secret_cifrado, aadCredencialMeta(f.id, f.organization_id, "app_secret")),
        accessToken: opts.cifrador.descifrar(f.access_token_cifrado, aadCredencialMeta(f.id, f.organization_id, "access_token")),
        verifyTokenHash: f.verify_token_hash,
        phoneNumberIds: [...f.phone_number_ids],
      };
    } catch {
      avisar(f.id);
      return null;
    }
  }

  async function cargar(): Promise<NonNullable<typeof cache>> {
    if (cache && cache.hasta > ahora()) return cache;
    if (enCurso) return enCurso;
    const miGeneracion = generacion;
    enCurso = (async () => {
      try {
        const credenciales = (await opts.leer()).map(descifrar).filter((c): c is CredencialMeta => c !== null);
        const porNumero = new Map<string, CredencialMeta>();
        for (const c of credenciales) for (const n of c.phoneNumberIds) porNumero.set(n, c);
        const nueva = { hasta: ahora() + ttl, credenciales, porNumero };
        if (miGeneracion === generacion) cache = nueva;
        return nueva;
      } finally {
        enCurso = null;
      }
    })();
    return enCurso;
  }

  return {
    async credencialDeNumero(phoneNumberId) {
      return (await cargar()).porNumero.get(phoneNumberId) ?? null;
    },
    async todas() {
      return (await cargar()).credenciales;
    },
    async verifyTokenValido(token) {
      try {
        const hashes = (await cargar()).credenciales.map((c) => c.verifyTokenHash).filter((h): h is string => h !== null);
        return verifyTokenEnHashes(token, hashes);
      } catch {
        return false;
      }
    },
    invalidar() {
      generacion += 1;
      cache = null;
    },
  };
}

/** Quien firmo un webhook y por cuales numeros puede hablar. */
export type AutorizacionWebhookMeta =
  /** App de plataforma (WHATSAPP_APP_SECRET): todos los numeros MENOS los que tienen app propia. */
  | { readonly tipo: "plataforma"; readonly excluidos: ReadonlySet<string> }
  /** App propia de una organizacion: SOLO los numeros asignados a esa credencial. */
  | {
      readonly tipo: "credencial";
      readonly credencialId: string;
      readonly organizationId: string;
      readonly numeros: ReadonlySet<string>;
    };

export type ResultadoAutorizacionWebhook = { readonly ok: true; readonly autorizacion: AutorizacionWebhookMeta } | { readonly ok: false; readonly status: 401 | 503 };

/** Tope de credenciales contra las que se prueba una firma cuando el payload no trae ningun numero asignado. */
const MAX_CANDIDATOS_SIN_NUMERO = 50;

export async function autorizarWebhookMeta(args: {
  readonly rawBody: Uint8Array;
  readonly firma: string | null;
  readonly secretoPlataforma: string;
  readonly resolutor?: ResolutorCredencialesMeta;
  /** Numeros (`phone_number_id`) del payload; solo se consulta si la firma no es de la plataforma. */
  readonly numerosDelPayload: () => readonly string[];
}): Promise<ResultadoAutorizacionWebhook> {
  if (verificarFirmaConCandidatos(args.rawBody, args.firma, [{ id: "plataforma", appSecret: args.secretoPlataforma }]) !== null) {
    let excluidos = new Set<string>();
    if (args.resolutor) {
      try {
        excluidos = new Set((await args.resolutor.todas()).flatMap((c) => c.phoneNumberIds));
      } catch {
        // La app de plataforma es de confianza: sin poder leer las credenciales se procesa como siempre (defensa en profundidad, no la barrera).
      }
    }
    return { ok: true, autorizacion: { tipo: "plataforma", excluidos } };
  }
  if (!args.resolutor) return { ok: false, status: 401 };
  let todas: readonly CredencialMeta[];
  try {
    todas = await args.resolutor.todas();
  } catch {
    return { ok: false, status: 503 };
  }
  const numeros = new Set(args.numerosDelPayload());
  const porNumero = todas.filter((c) => c.phoneNumberIds.some((n) => numeros.has(n)));
  const candidatos = porNumero.length > 0 ? porNumero : todas.slice(0, MAX_CANDIDATOS_SIN_NUMERO);
  const id = verificarFirmaConCandidatos(
    args.rawBody,
    args.firma,
    candidatos.map((c) => ({ id: c.id, appSecret: c.appSecret })),
  );
  const credencial = id === null ? undefined : candidatos.find((c) => c.id === id);
  if (!credencial) return { ok: false, status: 401 };
  return {
    ok: true,
    autorizacion: {
      tipo: "credencial",
      credencialId: credencial.id,
      organizationId: credencial.organizationId,
      numeros: new Set(credencial.phoneNumberIds),
    },
  };
}

/** `true` si quien firmo el webhook puede hablar por ese numero. */
export function numeroAutorizado(a: AutorizacionWebhookMeta, phoneNumberId: string): boolean {
  return a.tipo === "plataforma" ? !a.excluidos.has(phoneNumberId) : a.numeros.has(phoneNumberId);
}
