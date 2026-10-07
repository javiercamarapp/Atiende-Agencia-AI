// Scripts de activacion (Twilio y LiveKit) contra APIs SIMULADAS: nunca se ejecutaron contra las cuentas reales (no existen). Se afirma idempotencia (correr dos veces no
// duplica nada), ensayo sin escrituras, la guarda de compra, el formato de las peticiones y que ninguna credencial se imprime.
import { describe, expect, it } from "vitest";
import { configurarLivekit, numerosPuente } from "../../../scripts/voz/configurar-livekit.ts";
import type { ReglaDespacho, SipApi, TrunkEntrada } from "../../../scripts/voz/configurar-livekit.ts";
import { NOMBRE_NUMERO, configurarTwilio, opcionesTwilioDeEntorno, sipUriDeLivekit } from "../../../scripts/voz/configurar-twilio.ts";
import type { OpcionesTwilio } from "../../../scripts/voz/configurar-twilio.ts";
import { faltantes, hayError, imprimirPasos, leerBanderas, sinSecretos } from "../../../scripts/voz/lib.ts";

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ Twilio simulado
interface EstadoTwilio {
  numeros: { sid: string; phone_number: string; friendly_name?: string }[];
  disponibles: string[];
  trunks: { sid: string; friendly_name: string }[];
  origination: Map<string, { sip_url: string; enabled: boolean }[]>;
  enTrunk: Map<string, string[]>;
  escrituras: { url: string; cuerpo: Record<string, string> }[];
  autorizaciones: string[];
  fallaCon?: number;
}

function twilioSimulado(parcial: Partial<EstadoTwilio> = {}) {
  const e: EstadoTwilio = { numeros: [], disponibles: ["+529995550123"], trunks: [], origination: new Map(), enTrunk: new Map(), escrituras: [], autorizaciones: [], ...parcial };
  let n = 100;
  const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const metodo = init?.method ?? "GET";
    e.autorizaciones.push(new Headers(init?.headers).get("authorization") ?? "");
    if (e.fallaCon) return json({ message: "x" }, e.fallaCon);
    const cuerpo = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    if (metodo === "POST") e.escrituras.push({ url: url.pathname, cuerpo });
    const ruta = url.pathname;
    if (url.host === "api.twilio.com") {
      if (/IncomingPhoneNumbers\.json$/.test(ruta)) {
        if (metodo === "GET") return json({ incoming_phone_numbers: e.numeros, meta: { next_page_url: null } });
        const nuevo = { sid: `PN${++n}`, phone_number: cuerpo.PhoneNumber as string, friendly_name: cuerpo.FriendlyName };
        e.numeros.push(nuevo);
        return json(nuevo, 201);
      }
      if (/AvailablePhoneNumbers\/MX\/(Local|Mobile|TollFree)\.json$/.test(ruta)) return json({ available_phone_numbers: e.disponibles.map((p) => ({ phone_number: p })), meta: { next_page_url: null } });
    }
    if (url.host === "trunking.twilio.com") {
      if (ruta === "/v1/Trunks") {
        if (metodo === "GET") return json({ trunks: e.trunks, meta: { next_page_url: null } });
        const t = { sid: `TK${++n}`, friendly_name: cuerpo.FriendlyName as string };
        e.trunks.push(t);
        return json(t, 201);
      }
      const m = /^\/v1\/Trunks\/(TK\d+)\/(OriginationUrls|PhoneNumbers)$/.exec(ruta);
      if (m) {
        const [, sid, recurso] = m as unknown as [string, string, string];
        if (recurso === "OriginationUrls") {
          if (metodo === "GET") return json({ origination_urls: e.origination.get(sid) ?? [], meta: { next_page_url: null } });
          e.origination.set(sid, [...(e.origination.get(sid) ?? []), { sip_url: cuerpo.SipUrl as string, enabled: cuerpo.Enabled === "true" }]);
          return json({}, 201);
        }
        if (metodo === "GET") return json({ phone_numbers: (e.enTrunk.get(sid) ?? []).map((s) => ({ sid: s })), meta: { next_page_url: null } });
        e.enTrunk.set(sid, [...(e.enTrunk.get(sid) ?? []), cuerpo.PhoneNumberSid as string]);
        return json({}, 201);
      }
    }
    return json({ message: "no existe" }, 404);
  }) as typeof fetch;
  return { e, fetchFn };
}

const BASE_TWILIO: Omit<OpcionesTwilio, "fetchFn"> = {
  dryRun: false,
  comprar: false,
  numero: null,
  lada: "999",
  tipo: "local",
  nombreTrunk: "atiende-voz",
  livekitSipHost: "abc123.sip.livekit.cloud",
  cuentaSid: "ACcuenta",
  credencial: "ACcuenta:TOKEN-SECRETO-1234",
  bundleSid: "BUbundle",
  addressSid: "ADaddress",
};

describe("configurar-twilio", () => {
  it("ensayo: solo LEE (ninguna escritura), pero dice todo lo que haria", async () => {
    const t = twilioSimulado();
    const r = await configurarTwilio({ ...BASE_TWILIO, dryRun: true, comprar: true, fetchFn: t.fetchFn });
    expect(t.e.escrituras).toEqual([]);
    expect(r.pasos.map((p) => [p.paso, p.estado])).toEqual([["numero", "se_haria"], ["trunk", "se_haria"], ["origination", "se_haria"], ["numero_en_trunk", "se_haria"]]);
    expect(r.pasos[0]!.detalle).toContain("+529995550123");
  });

  it("sin --comprar NO compra: crea el trunk y el origination y deja el numero como pendiente de decision", async () => {
    const t = twilioSimulado();
    const r = await configurarTwilio({ ...BASE_TWILIO, fetchFn: t.fetchFn });
    expect(t.e.numeros).toEqual([]);
    expect(t.e.trunks).toHaveLength(1);
    expect(t.e.escrituras.some((w) => w.url.endsWith("IncomingPhoneNumbers.json"))).toBe(false);
    expect(r.pasos[0]).toMatchObject({ paso: "numero", estado: "se_haria" });
    expect(r.pasos[0]!.detalle).toContain("--comprar");
  });

  it("con --comprar compra el numero encontrado (con el bundle y la direccion regulatorios), crea el trunk, apunta el origination a LiveKit y asocia el numero", async () => {
    const t = twilioSimulado();
    const r = await configurarTwilio({ ...BASE_TWILIO, comprar: true, fetchFn: t.fetchFn });
    expect(r.numero).toBe("+529995550123");
    const compra = t.e.escrituras.find((w) => w.url.endsWith("IncomingPhoneNumbers.json"))!;
    expect(compra.cuerpo).toEqual({ PhoneNumber: "+529995550123", FriendlyName: NOMBRE_NUMERO, BundleSid: "BUbundle", AddressSid: "ADaddress" });
    const trunkSid = t.e.trunks[0]!.sid;
    expect(t.e.origination.get(trunkSid)).toEqual([{ sip_url: "sip:abc123.sip.livekit.cloud;transport=tcp", enabled: true }]);
    expect(t.e.enTrunk.get(trunkSid)).toEqual([t.e.numeros[0]!.sid]);
    expect(r.pasos.every((p) => p.estado === "hecho")).toBe(true);
  });

  it("es IDEMPOTENTE: la segunda corrida no escribe nada y todo sale 'ya existe'", async () => {
    const t = twilioSimulado();
    await configurarTwilio({ ...BASE_TWILIO, comprar: true, fetchFn: t.fetchFn });
    const antes = t.e.escrituras.length;
    const r = await configurarTwilio({ ...BASE_TWILIO, comprar: true, fetchFn: t.fetchFn });
    expect(t.e.escrituras).toHaveLength(antes);
    expect(r.pasos.map((p) => p.estado)).toEqual(["ya_existia", "ya_existia", "ya_existia", "ya_existia"]);
    expect(t.e.numeros).toHaveLength(1);
    expect(t.e.trunks).toHaveLength(1);
  });

  it("si el numero deseado ya es propio, lo usa y no compra; si el origination ya existe, no lo duplica", async () => {
    const t = twilioSimulado({ numeros: [{ sid: "PN1", phone_number: "+529991112222" }], trunks: [{ sid: "TK1", friendly_name: "atiende-voz" }], origination: new Map([["TK1", [{ sip_url: "sip:abc123.sip.livekit.cloud;transport=tcp", enabled: true }]]]) });
    const r = await configurarTwilio({ ...BASE_TWILIO, numero: "+529991112222", comprar: true, fetchFn: t.fetchFn });
    expect(t.e.escrituras.map((w) => w.url)).toEqual(["/v1/Trunks/TK1/PhoneNumbers"]);
    expect(r.pasos.map((p) => p.estado)).toEqual(["ya_existia", "ya_existia", "ya_existia", "hecho"]);
  });

  it("comprar en Mexico sin Regulatory Bundle o direccion queda BLOQUEADO (no compra nada)", async () => {
    const t = twilioSimulado();
    const r = await configurarTwilio({ ...BASE_TWILIO, comprar: true, bundleSid: null, fetchFn: t.fetchFn });
    expect(r.pasos[0]).toMatchObject({ paso: "numero", estado: "bloqueado" });
    expect(r.pasos[0]!.detalle).toContain("TWILIO_BUNDLE_SID");
    expect(t.e.numeros).toEqual([]);
    expect(hayError(r.pasos)).toBe(true);
  });

  it("sin numeros disponibles en la lada, lo dice y sugiere alternativas", async () => {
    const t = twilioSimulado({ disponibles: [] });
    const r = await configurarTwilio({ ...BASE_TWILIO, comprar: true, fetchFn: t.fetchFn });
    expect(r.pasos[0]).toMatchObject({ estado: "bloqueado" });
    expect(r.pasos[0]!.detalle).toContain("toll-free");
  });

  it("autentica con Basic y un error de Twilio sale como paso de error SIN la credencial", async () => {
    const t = twilioSimulado({ fallaCon: 401 });
    const r = await configurarTwilio({ ...BASE_TWILIO, fetchFn: t.fetchFn });
    expect(t.e.autorizaciones[0]).toBe(`Basic ${Buffer.from("ACcuenta:TOKEN-SECRETO-1234").toString("base64")}`);
    expect(r.pasos.at(-1)).toMatchObject({ paso: "twilio", estado: "error" });
    expect(JSON.stringify(r)).not.toContain("TOKEN-SECRETO");
  });

  it("sin credenciales el ensayo no toca la red y lo avisa; ejecutar sin credenciales queda bloqueado", async () => {
    let llamadas = 0;
    const fetchFn = (async () => (llamadas++, new Response("{}"))) as typeof fetch;
    const ensayo = await configurarTwilio({ ...BASE_TWILIO, dryRun: true, credencial: null, cuentaSid: null, fetchFn });
    expect(ensayo.pasos[0]).toMatchObject({ paso: "credenciales", estado: "se_haria" });
    const real = await configurarTwilio({ ...BASE_TWILIO, credencial: null, cuentaSid: null, fetchFn });
    expect(real.pasos[0]).toMatchObject({ estado: "bloqueado" });
    expect(llamadas).toBe(0);
  });

  it("el origination usa el host de LiveKit en la forma sip:<host>;transport=tcp", () => {
    expect(sipUriDeLivekit("abc123.sip.livekit.cloud")).toBe("sip:abc123.sip.livekit.cloud;transport=tcp");
  });
});

describe("opcionesTwilioDeEntorno", () => {
  const ENV = { LIVEKIT_SIP_URI: "sip:abc123.sip.livekit.cloud;transport=tcp", TWILIO_ACCOUNT_SID: "ACx", TWILIO_AUTH_TOKEN: "tok" };
  it("ensayo por omision, lada 999, tipo local y host de LiveKit sin esquema", () => {
    expect(opcionesTwilioDeEntorno([], ENV)).toMatchObject({ dryRun: true, comprar: false, lada: "999", tipo: "local", livekitSipHost: "abc123.sip.livekit.cloud", credencial: "ACx:tok" });
  });
  it("--ejecutar y --comprar son explicitos; la llave de API gana al token de cuenta", () => {
    const o = opcionesTwilioDeEntorno(["--ejecutar", "--comprar", "--numero=+529991112222", "--tipo=toll-free"], { ...ENV, TWILIO_API_KEY_SID: "SKx", TWILIO_API_KEY_SECRET: "sec" });
    expect(o).toMatchObject({ dryRun: false, comprar: true, numero: "+529991112222", tipo: "toll-free", credencial: "SKx:sec" });
  });
  it("rechaza banderas desconocidas, numeros fuera de E.164 mexicano, tipos invalidos y falta de LIVEKIT_SIP_URI", () => {
    expect(() => opcionesTwilioDeEntorno(["--borrar"], ENV)).toThrow(/desconocida/);
    expect(() => opcionesTwilioDeEntorno(["--numero=9991112222"], ENV)).toThrow(/E\.164/);
    expect(() => opcionesTwilioDeEntorno(["--tipo=satelital"], ENV)).toThrow(/--tipo/);
    expect(() => opcionesTwilioDeEntorno([], {})).toThrow(/LIVEKIT_SIP_URI/);
    expect(() => opcionesTwilioDeEntorno([], { ...ENV, LIVEKIT_SIP_URI: "no es host" })).toThrow(/host SIP/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ LiveKit simulado
function sipSimulado(inicial: { trunks?: TrunkEntrada[]; reglas?: ReglaDespacho[] } = {}) {
  const trunks: TrunkEntrada[] = [...(inicial.trunks ?? [])];
  const reglas: ReglaDespacho[] = [...(inicial.reglas ?? [])];
  const escrituras: string[] = [];
  const api: SipApi = {
    async listarTrunksEntrada() {
      return trunks;
    },
    async crearTrunkEntrada(e) {
      escrituras.push("crearTrunk");
      const t: TrunkEntrada = { id: `ST_${trunks.length + 1}`, nombre: e.nombre, numeros: e.numeros, direcciones: e.direcciones, cabecerasComoAtributos: true };
      trunks.push(t);
      return t;
    },
    async fijarNumerosTrunk(id, numeros) {
      escrituras.push("fijarNumeros");
      const i = trunks.findIndex((t) => t.id === id);
      trunks[i] = { ...trunks[i]!, numeros };
    },
    async activarCabecerasComoAtributos(id) {
      escrituras.push("activarCabeceras");
      const i = trunks.findIndex((t) => t.id === id);
      trunks[i] = { ...trunks[i]!, cabecerasComoAtributos: true };
    },
    async listarReglas() {
      return reglas;
    },
    async crearReglaIndividual(e) {
      escrituras.push("crearRegla");
      const r: ReglaDespacho = { id: `SDR_${reglas.length + 1}`, nombre: e.nombre, trunkIds: e.trunkIds, tipo: "individual", prefijoSala: e.prefijoSala };
      reglas.push(r);
      return r;
    },
    async fijarTrunksRegla(id, trunkIds) {
      escrituras.push("fijarTrunksRegla");
      const i = reglas.findIndex((r) => r.id === id);
      reglas[i] = { ...reglas[i]!, trunkIds };
    },
  };
  return { api, trunks, reglas, escrituras };
}

const BASE_LK = { dryRun: false, numeros: ["+529991110001"], nombreTrunk: "atiende-voz-entrada", nombreRegla: "atiende-voz-llamadas", prefijoSala: "llamada-", direccionesPermitidas: [] as string[] };

describe("configurar-livekit", () => {
  it("ensayo: no escribe nada y lista lo que haria (y avisa que el trunk queda sin restriccion de IP)", async () => {
    const s = sipSimulado();
    const r = await configurarLivekit({ ...BASE_LK, dryRun: true, api: s.api });
    expect(s.escrituras).toEqual([]);
    expect(r.pasos.map((p) => [p.paso, p.estado])).toEqual([["trunk_entrada", "se_haria"], ["regla_despacho", "se_haria"]]);
    expect(r.pasos[0]!.detalle).toContain("LIVEKIT_ALLOWED_ADDRESSES");
  });

  it("crea el trunk de entrada (solo los numeros puente) y la regla INDIVIDUAL con prefijo llamada- apuntando a ese trunk", async () => {
    const s = sipSimulado();
    const r = await configurarLivekit({ ...BASE_LK, direccionesPermitidas: ["54.172.60.0/30"], api: s.api });
    expect(s.trunks[0]).toMatchObject({ nombre: "atiende-voz-entrada", numeros: ["+529991110001"], direcciones: ["54.172.60.0/30"], cabecerasComoAtributos: true });
    expect(s.reglas[0]).toMatchObject({ nombre: "atiende-voz-llamadas", tipo: "individual", prefijoSala: "llamada-", trunkIds: [s.trunks[0]!.id] });
    expect(r.pasos.every((p) => p.estado === "hecho")).toBe(true);
  });

  it("es IDEMPOTENTE: la segunda corrida no escribe nada", async () => {
    const s = sipSimulado();
    await configurarLivekit({ ...BASE_LK, api: s.api });
    const antes = s.escrituras.length;
    const r = await configurarLivekit({ ...BASE_LK, api: s.api });
    expect(s.escrituras).toHaveLength(antes);
    expect(r.pasos.every((p) => p.estado === "ya_existia")).toBe(true);
  });

  it("corrige un trunk con numeros distintos y sin encabezados como atributos (sin ellos no se ve la Diversion), y una regla que no apunta al trunk", async () => {
    const s = sipSimulado({
      trunks: [{ id: "ST_9", nombre: "atiende-voz-entrada", numeros: ["+529990000000"], direcciones: [], cabecerasComoAtributos: false }],
      reglas: [{ id: "SDR_9", nombre: "atiende-voz-llamadas", trunkIds: [], tipo: "individual", prefijoSala: "llamada-" }],
    });
    await configurarLivekit({ ...BASE_LK, api: s.api });
    expect(s.escrituras).toEqual(["fijarNumeros", "activarCabeceras", "fijarTrunksRegla"]);
    expect(s.trunks[0]).toMatchObject({ numeros: ["+529991110001"], cabecerasComoAtributos: true });
    expect(s.reglas[0]!.trunkIds).toEqual(["ST_9"]);
  });

  it("una regla con el mismo nombre pero de OTRO tipo o prefijo bloquea (el script nunca borra reglas)", async () => {
    const s = sipSimulado({ reglas: [{ id: "SDR_1", nombre: "atiende-voz-llamadas", trunkIds: [], tipo: "otro", prefijoSala: null }] });
    const r = await configurarLivekit({ ...BASE_LK, api: s.api });
    expect(r.pasos.at(-1)).toMatchObject({ paso: "regla_despacho", estado: "bloqueado" });
    expect(hayError(r.pasos)).toBe(true);
    expect(s.escrituras).not.toContain("crearRegla");
  });

  it("un error de la API sale como paso de error con un mensaje corto", async () => {
    const s = sipSimulado();
    s.api.listarTrunksEntrada = async () => {
      throw new Error("401 unauthorized");
    };
    const r = await configurarLivekit({ ...BASE_LK, api: s.api });
    expect(r.pasos).toEqual([{ paso: "livekit", estado: "error", detalle: "401 unauthorized" }]);
  });
});

describe("numerosPuente", () => {
  it("por omision son las claves de VOICE_DNIS_MAP en E.164 mexicano, sin repetidos", () => {
    expect(numerosPuente(undefined, JSON.stringify({ "+52 999 111 0001": {}, "9991110001": {}, "(999) 111-0002": {} }))).toEqual(["+529991110001", "+529991110002"]);
  });
  it("--numeros gana al mapa; sin ninguna fuente o con un numero corto falla", () => {
    expect(numerosPuente("+52 999 333 0003", "{}")).toEqual(["+529993330003"]);
    expect(() => numerosPuente(undefined, undefined)).toThrow(/Sin numeros/);
    expect(() => numerosPuente("123", undefined)).toThrow(/no valido/);
    expect(() => numerosPuente(undefined, "{no")).toThrow(/JSON/);
  });
});

describe("lib de los scripts", () => {
  it("leerBanderas: ensayo por omision, --ejecutar lo apaga y una bandera desconocida lanza", () => {
    expect(leerBanderas([], { valores: [], interruptores: [] }).dryRun).toBe(true);
    expect(leerBanderas(["--ejecutar"], { valores: [], interruptores: [] }).dryRun).toBe(false);
    expect(leerBanderas(["--ejecutar", "--dry-run"], { valores: [], interruptores: [] }).dryRun).toBe(true);
    expect(() => leerBanderas(["--x"], { valores: [], interruptores: [] })).toThrow();
    expect(() => leerBanderas(["texto"], { valores: [], interruptores: [] })).toThrow();
  });
  it("faltantes solo da nombres; sinSecretos tacha valores; imprimirPasos marca el modo", () => {
    expect(faltantes({ A: "x", B: " " }, ["A", "B", "C"])).toEqual(["B", "C"]);
    expect(sinSecretos("token=SECRETO123 y mas", ["SECRETO123", undefined])).toBe("token=*** y mas");
    expect(imprimirPasos("T", [{ paso: "p", estado: "se_haria", detalle: "d" }], true)).toContain("ENSAYO");
    expect(imprimirPasos("T", [{ paso: "p", estado: "hecho", detalle: "d" }], false)).toContain("EJECUTADO");
  });
});
