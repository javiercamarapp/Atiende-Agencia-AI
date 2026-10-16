// Twilio para la voz de PM, IDEMPOTENTE: buscar o comprar el numero mexicano, crear el Elastic SIP Trunk y apuntar su ORIGINATION a LiveKit, y asociar el numero al trunk.
// NO se ha ejecutado nunca (no hay cuenta de Twilio): se prueba contra una API de Twilio SIMULADA (`apps/voice-worker/tests/scripts-activacion.spec.ts`).
//
//   npm run voz:twilio                       # ENSAYO (por omision): solo lee y dice que haria
//   npm run voz:twilio -- --ejecutar         # crea el trunk, apunta el origination y asocia el numero (si ya hay numero)
//   npm run voz:twilio -- --ejecutar --comprar   # ademas COMPRA un numero si no hay (cuesta ~US$6.25/mes; lo decide Javier)
//
// Banderas: --numero=+52999... (el que ya tienes o quieres comprar)  --lada=999 (para buscar uno)  --tipo=local|mobile|toll-free  --trunk=<nombre>
// Variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (o TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET), LIVEKIT_SIP_URI (ej. abc123.sip.livekit.cloud: sale de los ajustes del proyecto
// de LiveKit Cloud), y para COMPRAR en Mexico TWILIO_BUNDLE_SID (Regulatory Bundle aprobado) y TWILIO_ADDRESS_SID. Nunca imprime ni registra las credenciales.
import { pathToFileURL } from "node:url";
import { faltantes, hayError, imprimirPasos, leerBanderas, sinSecretos } from "./lib.ts";
import type { Paso } from "./lib.ts";

export type TipoNumero = "local" | "mobile" | "toll-free";
const RUTA_DISPONIBLES: Record<TipoNumero, string> = { local: "Local", mobile: "Mobile", "toll-free": "TollFree" };

export interface OpcionesTwilio {
  readonly dryRun: boolean;
  readonly comprar: boolean;
  /** Numero E.164 deseado o ya propio; null = buscar uno. */
  readonly numero: string | null;
  readonly lada: string;
  readonly tipo: TipoNumero;
  readonly nombreTrunk: string;
  /** Host SIP de LiveKit (sin esquema), ej. `abc123.sip.livekit.cloud`. */
  readonly livekitSipHost: string;
  readonly cuentaSid: string | null;
  /** Credencial Basic: `usuario:secreto` (AccountSid:AuthToken o ApiKeySid:ApiKeySecret). null = sin credenciales (el ensayo no lee nada). */
  readonly credencial: string | null;
  readonly bundleSid: string | null;
  readonly addressSid: string | null;
  readonly fetchFn?: typeof fetch;
}

export interface ResultadoTwilio {
  readonly pasos: readonly Paso[];
  readonly trunkSid: string | null;
  readonly numero: string | null;
}

// Sin "parameter properties": `node --experimental-strip-types` no las admite.
class ErrorTwilio extends Error {
  readonly estado: number;
  constructor(estado: number) {
    super(`Twilio respondio ${estado}`);
    this.estado = estado;
  }
}

const TRUNKING = "https://trunking.twilio.com/v1";
const API = "https://api.twilio.com/2010-04-01";
export const NOMBRE_NUMERO = "atiende-voz";

export function sipUriDeLivekit(host: string): string {
  return `sip:${host};transport=tcp`;
}

export async function configurarTwilio(o: OpcionesTwilio): Promise<ResultadoTwilio> {
  const fetchFn = o.fetchFn ?? fetch;
  const pasos: Paso[] = [];
  const autenticacion = o.credencial === null ? null : `Basic ${Buffer.from(o.credencial).toString("base64")}`;

  async function llamar<T>(metodo: "GET" | "POST", url: string, formulario?: Record<string, string>): Promise<T> {
    const res = await fetchFn(url, {
      method: metodo,
      headers: { authorization: autenticacion ?? "", accept: "application/json", ...(formulario ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(formulario ? { body: new URLSearchParams(formulario).toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new ErrorTwilio(res.status);
    return (await res.json()) as T;
  }
  const lista = async <T>(url: string, clave: string): Promise<T[]> => {
    const salida: T[] = [];
    let siguiente: string | null = url;
    for (let i = 0; siguiente !== null && i < 20; i++) {
      const pagina: Record<string, unknown> = await llamar<Record<string, unknown>>("GET", siguiente);
      salida.push(...((pagina[clave] as T[] | undefined) ?? []));
      const meta = pagina.meta as { next_page_url?: string | null } | undefined;
      siguiente = meta?.next_page_url ?? null;
    }
    return salida;
  };

  if (autenticacion === null || o.cuentaSid === null) {
    pasos.push({ paso: "credenciales", estado: o.dryRun ? "se_haria" : "bloqueado", detalle: "Sin TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN no se puede leer el estado actual. Pasos que se harian: buscar o comprar numero, crear trunk, apuntar origination, asociar numero." });
    return { pasos, trunkSid: null, numero: o.numero };
  }

  try {
    // 1) Numero: el deseado si ya es propio; si no, uno propio llamado `atiende-voz`; si no, buscar/comprar.
    const propios = await lista<{ sid: string; phone_number: string; friendly_name?: string }>(`${API}/Accounts/${o.cuentaSid}/IncomingPhoneNumbers.json?PageSize=100`, "incoming_phone_numbers");
    let numero = o.numero;
    let numeroSid: string | null = null;
    const propio = propios.find((n) => (o.numero !== null ? n.phone_number === o.numero : n.friendly_name === NOMBRE_NUMERO));
    if (propio) {
      numero = propio.phone_number;
      numeroSid = propio.sid;
      pasos.push({ paso: "numero", estado: "ya_existia", detalle: `${propio.phone_number} ya es de la cuenta.` });
    } else if (!o.comprar) {
      pasos.push({ paso: "numero", estado: "se_haria", detalle: `No hay numero propio${o.numero ? ` (${o.numero})` : ""}: con --comprar se ${o.numero ? "compraria ese" : `buscaria uno ${o.tipo} ${o.lada} en MX y se compraria`} (~US$6.25/mes, lo decide Javier).` });
    } else {
      if (numero === null) {
        const disponibles = await lista<{ phone_number: string }>(`${API}/Accounts/${o.cuentaSid}/AvailablePhoneNumbers/MX/${RUTA_DISPONIBLES[o.tipo]}.json?${o.tipo === "toll-free" ? "" : `AreaCode=${encodeURIComponent(o.lada)}&`}VoiceEnabled=true&PageSize=5`, "available_phone_numbers");
        numero = disponibles[0]?.phone_number ?? null;
        if (numero === null) pasos.push({ paso: "numero", estado: "bloqueado", detalle: `Twilio no tiene numeros ${o.tipo} con lada ${o.lada} en MX. Prueba otra --lada, --tipo=toll-free (US$30/mes, cualquier domicilio) o Telnyx.` });
      }
      if (numero !== null) {
        if (o.bundleSid === null || o.addressSid === null) {
          pasos.push({ paso: "numero", estado: "bloqueado", detalle: "Para comprar en Mexico faltan TWILIO_BUNDLE_SID (Regulatory Bundle aprobado) y TWILIO_ADDRESS_SID." });
          numero = null;
        } else if (o.dryRun) {
          pasos.push({ paso: "numero", estado: "se_haria", detalle: `Se compraria ${numero} (~US$6.25/mes).` });
        } else {
          const comprado = await llamar<{ sid: string; phone_number: string }>("POST", `${API}/Accounts/${o.cuentaSid}/IncomingPhoneNumbers.json`, { PhoneNumber: numero, FriendlyName: NOMBRE_NUMERO, BundleSid: o.bundleSid, AddressSid: o.addressSid });
          numero = comprado.phone_number;
          numeroSid = comprado.sid;
          pasos.push({ paso: "numero", estado: "hecho", detalle: `Comprado ${comprado.phone_number}.` });
        }
      }
    }

    // 2) Trunk (por nombre).
    const trunks = await lista<{ sid: string; friendly_name: string }>(`${TRUNKING}/Trunks?PageSize=100`, "trunks");
    let trunkSid: string | null = trunks.find((t) => t.friendly_name === o.nombreTrunk)?.sid ?? null;
    if (trunkSid) pasos.push({ paso: "trunk", estado: "ya_existia", detalle: `${o.nombreTrunk} (${trunkSid}).` });
    else if (o.dryRun) pasos.push({ paso: "trunk", estado: "se_haria", detalle: `Se crearia el Elastic SIP Trunk ${o.nombreTrunk}.` });
    else {
      const t = await llamar<{ sid: string }>("POST", `${TRUNKING}/Trunks`, { FriendlyName: o.nombreTrunk });
      trunkSid = t.sid;
      pasos.push({ paso: "trunk", estado: "hecho", detalle: `${o.nombreTrunk} (${t.sid}).` });
    }

    // 3) Origination hacia LiveKit.
    const uri = sipUriDeLivekit(o.livekitSipHost);
    if (trunkSid) {
      const urls = await lista<{ sip_url: string; enabled: boolean }>(`${TRUNKING}/Trunks/${trunkSid}/OriginationUrls?PageSize=100`, "origination_urls");
      if (urls.some((u) => u.sip_url === uri && u.enabled)) pasos.push({ paso: "origination", estado: "ya_existia", detalle: `${uri}.` });
      else if (o.dryRun) pasos.push({ paso: "origination", estado: "se_haria", detalle: `Se apuntaria el origination a ${uri}.` });
      else {
        await llamar("POST", `${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`, { FriendlyName: "livekit", SipUrl: uri, Priority: "10", Weight: "10", Enabled: "true" });
        pasos.push({ paso: "origination", estado: "hecho", detalle: `${uri}.` });
      }
    } else pasos.push({ paso: "origination", estado: "se_haria", detalle: `Tras crear el trunk se apuntaria a ${uri}.` });

    // 4) Numero asociado al trunk.
    if (trunkSid && numeroSid) {
      const asociados = await lista<{ sid: string; phone_number: string }>(`${TRUNKING}/Trunks/${trunkSid}/PhoneNumbers?PageSize=100`, "phone_numbers");
      if (asociados.some((a) => a.sid === numeroSid)) pasos.push({ paso: "numero_en_trunk", estado: "ya_existia", detalle: `${numero ?? numeroSid} ya esta en el trunk.` });
      else if (o.dryRun) pasos.push({ paso: "numero_en_trunk", estado: "se_haria", detalle: `Se asociaria ${numero ?? numeroSid} al trunk.` });
      else {
        await llamar("POST", `${TRUNKING}/Trunks/${trunkSid}/PhoneNumbers`, { PhoneNumberSid: numeroSid });
        pasos.push({ paso: "numero_en_trunk", estado: "hecho", detalle: `${numero ?? numeroSid} asociado.` });
      }
    } else {
      pasos.push({ paso: "numero_en_trunk", estado: "se_haria", detalle: "Se asociaria el numero al trunk cuando exista el numero y el trunk." });
    }
    return { pasos, trunkSid, numero };
  } catch (err) {
    const detalle = err instanceof ErrorTwilio ? `Twilio respondio ${err.estado}. Revisa las credenciales y los permisos.` : "No se pudo hablar con Twilio.";
    pasos.push({ paso: "twilio", estado: "error", detalle: sinSecretos(detalle, [o.credencial ?? undefined, o.cuentaSid ?? undefined]) });
    return { pasos, trunkSid: null, numero: o.numero };
  }
}

export function opcionesTwilioDeEntorno(args: readonly string[], env: Readonly<Record<string, string | undefined>>): OpcionesTwilio {
  const b = leerBanderas(args, { valores: ["numero", "lada", "tipo", "trunk"], interruptores: ["comprar"] });
  const tipo = (b.valores.get("tipo") ?? "local") as TipoNumero;
  if (!(tipo in RUTA_DISPONIBLES)) throw new Error("--tipo debe ser local, mobile o toll-free.");
  const faltan = faltantes(env, ["LIVEKIT_SIP_URI"]);
  if (faltan.length > 0) throw new Error(`Falta ${faltan.join(", ")} (host SIP de tu proyecto de LiveKit Cloud, ej. abc123.sip.livekit.cloud).`);
  const host = (env.LIVEKIT_SIP_URI ?? "").trim().replace(/^sips?:/, "").replace(/;.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error("LIVEKIT_SIP_URI no parece un host SIP (ej. abc123.sip.livekit.cloud).");
  const numero = b.valores.get("numero") ?? null;
  if (numero !== null && !/^\+52\d{10}$/.test(numero)) throw new Error("--numero debe estar en formato E.164 mexicano (+52 y 10 digitos).");
  const llaveSid = env.TWILIO_API_KEY_SID?.trim();
  const llaveSecreto = env.TWILIO_API_KEY_SECRET?.trim();
  const cuenta = env.TWILIO_ACCOUNT_SID?.trim() || null;
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  const credencial = llaveSid && llaveSecreto ? `${llaveSid}:${llaveSecreto}` : cuenta && token ? `${cuenta}:${token}` : null;
  return {
    dryRun: b.dryRun,
    comprar: b.interruptores.has("comprar"),
    numero,
    lada: b.valores.get("lada") ?? "999",
    tipo,
    nombreTrunk: b.valores.get("trunk") ?? "atiende-voz",
    livekitSipHost: host,
    cuentaSid: cuenta,
    credencial,
    bundleSid: env.TWILIO_BUNDLE_SID?.trim() || null,
    addressSid: env.TWILIO_ADDRESS_SID?.trim() || null,
  };
}

async function main(): Promise<void> {
  let o: OpcionesTwilio;
  try {
    o = opcionesTwilioDeEntorno(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Argumentos no validos.");
    process.exit(2);
  }
  const r = await configurarTwilio(o);
  console.log(imprimirPasos("Twilio", r.pasos, o.dryRun));
  if (r.numero) console.log(`\nNumero puente: ${r.numero}. Anotalo en VOICE_DNIS_MAP y en npm run voz:livekit.`);
  process.exit(hayError(r.pasos) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
