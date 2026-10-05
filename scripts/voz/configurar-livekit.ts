// LiveKit para la voz de PM, IDEMPOTENTE: inbound trunk SIP (solo acepta los numeros puente de VOICE_DNIS_MAP) y regla de despacho INDIVIDUAL (una sala por llamada, con prefijo
// `llamada-`) que vuelve atributos del participante los encabezados SIP (`sip.h.*`: ahi llegan `Diversion` / `History-Info`). Sin estos dos recursos el worker no recibe llamadas.
// NO se ha ejecutado nunca (no hay proyecto de LiveKit Cloud): se prueba con una API SIP SIMULADA (`apps/voice-worker/tests/scripts-activacion.spec.ts`).
//
//   npm run voz:livekit                 # ENSAYO (por omision): solo lee y dice que haria
//   npm run voz:livekit -- --ejecutar   # crea o corrige el trunk y la regla
//
// Banderas: --numeros=+52999...,+52999... (por omision las claves de VOICE_DNIS_MAP)  --trunk=<nombre>  --regla=<nombre>  --prefijo=llamada-
// Variables: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET; opcional LIVEKIT_ALLOWED_ADDRESSES (CIDR/IP de Twilio separadas por coma: endurece el trunk). Nunca imprime secretos.
import { pathToFileURL } from "node:url";
import { faltantes, hayError, imprimirPasos, leerBanderas, sinSecretos } from "./lib.ts";
import type { Paso } from "./lib.ts";

export interface TrunkEntrada {
  readonly id: string;
  readonly nombre: string;
  readonly numeros: readonly string[];
  readonly direcciones: readonly string[];
  /** Los encabezados SIP se vuelven atributos del participante (`sip.h.*`). */
  readonly cabecerasComoAtributos: boolean;
}

export interface ReglaDespacho {
  readonly id: string;
  readonly nombre: string;
  readonly trunkIds: readonly string[];
  readonly tipo: "individual" | "otro";
  readonly prefijoSala: string | null;
}

/** Lo unico que el script necesita de LiveKit: se implementa con `SipClient` (real) o con un doble (pruebas). */
export interface SipApi {
  listarTrunksEntrada(): Promise<readonly TrunkEntrada[]>;
  crearTrunkEntrada(e: { nombre: string; numeros: readonly string[]; direcciones: readonly string[] }): Promise<TrunkEntrada>;
  fijarNumerosTrunk(id: string, numeros: readonly string[]): Promise<void>;
  activarCabecerasComoAtributos(id: string): Promise<void>;
  listarReglas(): Promise<readonly ReglaDespacho[]>;
  crearReglaIndividual(e: { nombre: string; prefijoSala: string; trunkIds: readonly string[] }): Promise<ReglaDespacho>;
  fijarTrunksRegla(id: string, trunkIds: readonly string[]): Promise<void>;
}

export interface OpcionesLivekit {
  readonly dryRun: boolean;
  readonly numeros: readonly string[];
  readonly nombreTrunk: string;
  readonly nombreRegla: string;
  readonly prefijoSala: string;
  readonly direccionesPermitidas: readonly string[];
  readonly api: SipApi;
}

export interface ResultadoLivekit {
  readonly pasos: readonly Paso[];
  readonly trunkId: string | null;
  readonly reglaId: string | null;
}

const mismos = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export async function configurarLivekit(o: OpcionesLivekit): Promise<ResultadoLivekit> {
  const pasos: Paso[] = [];
  let trunkId: string | null = null;
  let reglaId: string | null = null;
  try {
    // 1) Inbound trunk: SOLO los numeros puente (una llamada a cualquier otro numero no entra).
    const trunks = await o.api.listarTrunksEntrada();
    const trunk = trunks.find((t) => t.nombre === o.nombreTrunk);
    if (!trunk) {
      if (o.dryRun) pasos.push({ paso: "trunk_entrada", estado: "se_haria", detalle: `Se crearia ${o.nombreTrunk} para ${o.numeros.join(", ")}${o.direccionesPermitidas.length ? ` (solo desde ${o.direccionesPermitidas.length} direcciones)` : " (sin restriccion de direccion IP: define LIVEKIT_ALLOWED_ADDRESSES)"}.` });
      else {
        const creado = await o.api.crearTrunkEntrada({ nombre: o.nombreTrunk, numeros: o.numeros, direcciones: o.direccionesPermitidas });
        trunkId = creado.id;
        pasos.push({ paso: "trunk_entrada", estado: "hecho", detalle: `${o.nombreTrunk} (${creado.id}).` });
      }
    } else {
      trunkId = trunk.id;
      pasos.push({ paso: "trunk_entrada", estado: "ya_existia", detalle: `${o.nombreTrunk} (${trunk.id}).` });
      if (!mismos(trunk.numeros, o.numeros)) {
        if (o.dryRun) pasos.push({ paso: "trunk_numeros", estado: "se_haria", detalle: `Los numeros del trunk (${trunk.numeros.join(", ") || "ninguno"}) difieren de ${o.numeros.join(", ")}: se corregirian.` });
        else {
          await o.api.fijarNumerosTrunk(trunk.id, o.numeros);
          pasos.push({ paso: "trunk_numeros", estado: "hecho", detalle: `Numeros fijados: ${o.numeros.join(", ")}.` });
        }
      } else pasos.push({ paso: "trunk_numeros", estado: "ya_existia", detalle: o.numeros.join(", ") });
      if (!trunk.cabecerasComoAtributos) {
        if (o.dryRun) pasos.push({ paso: "trunk_cabeceras", estado: "se_haria", detalle: "El trunk no vuelve atributos los encabezados SIP (Diversion/History-Info): se activaria." });
        else {
          await o.api.activarCabecerasComoAtributos(trunk.id);
          pasos.push({ paso: "trunk_cabeceras", estado: "hecho", detalle: "Encabezados SIP como atributos activados." });
        }
      } else pasos.push({ paso: "trunk_cabeceras", estado: "ya_existia", detalle: "Encabezados SIP como atributos (sip.h.*)." });
    }

    // 2) Regla de despacho individual con prefijo.
    const reglas = await o.api.listarReglas();
    const regla = reglas.find((r) => r.nombre === o.nombreRegla);
    if (!regla) {
      if (o.dryRun || trunkId === null) pasos.push({ paso: "regla_despacho", estado: "se_haria", detalle: `Se crearia ${o.nombreRegla}: una sala por llamada con prefijo ${o.prefijoSala}${trunkId === null ? " (cuando exista el trunk)" : ""}.` });
      else {
        const creada = await o.api.crearReglaIndividual({ nombre: o.nombreRegla, prefijoSala: o.prefijoSala, trunkIds: [trunkId] });
        reglaId = creada.id;
        pasos.push({ paso: "regla_despacho", estado: "hecho", detalle: `${o.nombreRegla} (${creada.id}).` });
      }
    } else {
      reglaId = regla.id;
      if (regla.tipo !== "individual" || regla.prefijoSala !== o.prefijoSala) {
        pasos.push({ paso: "regla_despacho", estado: "bloqueado", detalle: `${o.nombreRegla} existe pero NO es individual con prefijo ${o.prefijoSala}: corrigela o borrala en la consola de LiveKit (el script no borra reglas).` });
      } else {
        pasos.push({ paso: "regla_despacho", estado: "ya_existia", detalle: `${o.nombreRegla} (${regla.id}), individual, prefijo ${regla.prefijoSala}.` });
        if (trunkId !== null && !regla.trunkIds.includes(trunkId)) {
          if (o.dryRun) pasos.push({ paso: "regla_trunk", estado: "se_haria", detalle: "La regla no apunta al trunk de entrada: se corregiria." });
          else {
            await o.api.fijarTrunksRegla(regla.id, [...new Set([...regla.trunkIds, trunkId])]);
            pasos.push({ paso: "regla_trunk", estado: "hecho", detalle: "La regla ahora incluye el trunk de entrada." });
          }
        } else if (trunkId !== null) pasos.push({ paso: "regla_trunk", estado: "ya_existia", detalle: "La regla apunta al trunk de entrada." });
      }
    }
  } catch (err) {
    pasos.push({ paso: "livekit", estado: "error", detalle: sinSecretos(err instanceof Error ? err.message.slice(0, 160) : "No se pudo hablar con LiveKit.", []) });
  }
  return { pasos, trunkId, reglaId };
}

/** Numeros puente: `--numeros` o, por omision, las claves de VOICE_DNIS_MAP (la misma tabla que lee el worker). Formato E.164 mexicano. */
export function numerosPuente(banderaNumeros: string | undefined, dnisMap: string | undefined): string[] {
  let crudos: string[] = [];
  if (banderaNumeros !== undefined) crudos = banderaNumeros.split(",").map((s) => s.trim()).filter(Boolean);
  else if (dnisMap && dnisMap.trim() !== "") {
    try {
      crudos = Object.keys(JSON.parse(dnisMap) as Record<string, unknown>);
    } catch {
      throw new Error("VOICE_DNIS_MAP no es JSON valido.");
    }
  }
  const e164 = crudos.map((n) => {
    const d = n.replace(/\D/g, "");
    if (d.length < 10) throw new Error(`Numero no valido: ${n.slice(-4).padStart(n.length, "*")}`);
    return `+52${d.slice(-10)}`;
  });
  if (e164.length === 0) throw new Error("Sin numeros puente: pasa --numeros=+52999... o define VOICE_DNIS_MAP.");
  return [...new Set(e164)];
}

/** Implementacion REAL con `SipClient` de livekit-server-sdk (import diferido: el SDK solo se carga al ejecutar de verdad). */
export async function crearSipApiReal(url: string, apiKey: string, apiSecret: string): Promise<SipApi> {
  const { SipClient } = await import("livekit-server-sdk");
  const { ListUpdate, SIPHeaderOptions, SIPInboundTrunkInfo } = await import("@livekit/protocol");
  const cliente = new SipClient(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), apiKey, apiSecret);
  const crudos = new Map<string, InstanceType<typeof SIPInboundTrunkInfo>>();
  const aTrunk = (t: InstanceType<typeof SIPInboundTrunkInfo>): TrunkEntrada => {
    crudos.set(t.sipTrunkId, t);
    return { id: t.sipTrunkId, nombre: t.name, numeros: t.numbers, direcciones: t.allowedAddresses, cabecerasComoAtributos: t.includeHeaders === SIPHeaderOptions.SIP_ALL_HEADERS };
  };
  return {
    async listarTrunksEntrada() {
      return (await cliente.listSipInboundTrunk()).map(aTrunk);
    },
    async crearTrunkEntrada(e) {
      return aTrunk(await cliente.createSipInboundTrunk(e.nombre, [...e.numeros], { allowedAddresses: [...e.direcciones], includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS, krispEnabled: false }));
    },
    async fijarNumerosTrunk(id, numeros) {
      await cliente.updateSipInboundTrunkFields(id, { numbers: new ListUpdate({ set: [...numeros] }) });
    },
    async activarCabecerasComoAtributos(id) {
      const actual = crudos.get(id);
      if (!actual) throw new Error("trunk_desconocido");
      await cliente.updateSipInboundTrunk(id, new SIPInboundTrunkInfo({ ...actual, includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS }));
    },
    async listarReglas() {
      return (await cliente.listSipDispatchRule()).map((r) => {
        const caso = r.rule?.rule;
        return { id: r.sipDispatchRuleId, nombre: r.name, trunkIds: r.trunkIds, tipo: caso?.case === "dispatchRuleIndividual" ? ("individual" as const) : ("otro" as const), prefijoSala: caso?.case === "dispatchRuleIndividual" ? caso.value.roomPrefix : null };
      });
    },
    async crearReglaIndividual(e) {
      const r = await cliente.createSipDispatchRule({ type: "individual", roomPrefix: e.prefijoSala }, { name: e.nombre, trunkIds: [...e.trunkIds], hidePhoneNumber: false });
      return { id: r.sipDispatchRuleId, nombre: r.name, trunkIds: r.trunkIds, tipo: "individual", prefijoSala: e.prefijoSala };
    },
    async fijarTrunksRegla(id, trunkIds) {
      await cliente.updateSipDispatchRuleFields(id, { trunkIds: new ListUpdate({ set: [...trunkIds] }) });
    },
  };
}

async function main(): Promise<void> {
  try {
    const b = leerBanderas(process.argv.slice(2), { valores: ["numeros", "trunk", "regla", "prefijo"], interruptores: [] });
    const falta = faltantes(process.env, ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]);
    if (falta.length > 0) throw new Error(`Faltan variables: ${falta.join(", ")}.`);
    const numeros = numerosPuente(b.valores.get("numeros"), process.env.VOICE_DNIS_MAP);
    const direcciones = (process.env.LIVEKIT_ALLOWED_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const api = await crearSipApiReal(process.env.LIVEKIT_URL as string, process.env.LIVEKIT_API_KEY as string, process.env.LIVEKIT_API_SECRET as string);
    const r = await configurarLivekit({ dryRun: b.dryRun, numeros, nombreTrunk: b.valores.get("trunk") ?? "atiende-voz-entrada", nombreRegla: b.valores.get("regla") ?? "atiende-voz-llamadas", prefijoSala: b.valores.get("prefijo") ?? "llamada-", direccionesPermitidas: direcciones, api });
    console.log(imprimirPasos("LiveKit", r.pasos, b.dryRun));
    process.exit(hayError(r.pasos) ? 1 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Error inesperado.");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
