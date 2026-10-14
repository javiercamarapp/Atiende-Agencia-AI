// ACEPTACION del detector ARCO (PR v2, reemplaza #533). Sin exclusiones por regex ni listas de "falsos positivos aceptados": cada frase etiquetada se evalua tal cual.
//   - Corpus del revisor independiente (209 frases: 115 ARCO, 84 no ARCO, 10 ambiguas), NO debilitado.
//   - Corpus propio (otras frases, ambas clases) y corpus POR RAIZ (cada raiz con positivos y casi-iguales negativos).
//   - Umbrales FIJADOS aqui: recall >= 98 % y falsos positivos <= los de main (5 de 84; main tenia recall 27 % y el #533 41 FP de 84).
import { describe, expect, it } from "vitest";
import { detectarOptOut } from "@atiende/whatsapp-gateway";
import { RAICES_ARCO, detectArcoIntent, esOposicionDeContacto, raicesQueCoinciden } from "../src/privacidad/arco-deteccion.ts";
import { CORPUS } from "./arco-corpus-revisor.ts";
import { CORPUS_PROPIO } from "./arco-corpus-propio.ts";
import { CASOS_POR_RAIZ } from "./arco-corpus-por-raiz.ts";
import { CORPUS_545 as DEV_545, RAFAGAS_545 as RAFAGAS_DEV } from "./arco-corpus-545-dev.ts";
import { CORPUS_545 as CIEGO_545, RAFAGAS_545 as RAFAGAS_CIEGO } from "./arco-corpus-545-ciego.ts";
import { intencionesPorMensaje } from "../src/privacidad/arco-intent.ts";

const FP_MAXIMO_MAIN = 5; // main: 5 de 84 negativos del revisor mandados al menu
const RECALL_MINIMO = 0.98;

const positivos = CORPUS.filter(([, e]) => e === "P").map(([f]) => f);
const negativos = CORPUS.filter(([, e]) => e === "N").map(([f]) => f);
const ambiguos = CORPUS.filter(([, e]) => e === "A").map(([f]) => f);

describe("corpus del revisor (aceptacion)", () => {
  it("tiene el tamano del original: 115 ARCO, 84 no ARCO, 10 ambiguas", () => {
    expect(positivos).toHaveLength(115);
    expect(negativos).toHaveLength(84);
    expect(ambiguos).toHaveLength(10);
  });
  it(`recall >= ${RECALL_MINIMO * 100} % (umbral fijo)`, () => {
    const detectados = positivos.filter((f) => detectArcoIntent(f) !== null).length;
    expect(detectados / positivos.length).toBeGreaterThanOrEqual(RECALL_MINIMO);
  });
  it(`falsos positivos <= main (${FP_MAXIMO_MAIN} de 84), medidos sobre TODOS los negativos y sin exclusiones`, () => {
    const fp = negativos.filter((f) => detectArcoIntent(f) !== null);
    expect(fp.length).toBeLessThanOrEqual(FP_MAXIMO_MAIN);
    expect(fp).toEqual([]); // hoy es 0: cualquier regresion aparece con su frase
  });
  it.each(positivos)("ARCO, nunca queda para el modelo: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).not.toBeNull();
  });
  it.each(negativos)("no ARCO: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).toBeNull();
  });
  it("las ambiguas solo se reportan: ninguna lanza", () => {
    for (const f of ambiguos) expect(() => detectArcoIntent(f)).not.toThrow();
  });
});

describe("corpus propio (otras frases, ambas clases)", () => {
  const p = CORPUS_PROPIO.filter(([, e]) => e === "P").map(([f]) => f);
  const n = CORPUS_PROPIO.filter(([, e]) => e === "N").map(([f]) => f);
  it("tiene al menos 60 ARCO y 60 no ARCO", () => {
    expect(p.length).toBeGreaterThanOrEqual(60);
    expect(n.length).toBeGreaterThanOrEqual(60);
  });
  it.each(p)("ARCO: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).not.toBeNull();
  });
  it.each(n)("no ARCO: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).toBeNull();
  });
});

describe("corpus POR RAIZ: cada raiz con positivos y casi-iguales negativos", () => {
  it("toda raiz tiene su corpus (>= 2 positivos y >= 2 negativos) y no sobran entradas", () => {
    const ids = RAICES_ARCO.map((r) => r.id);
    expect(ids.filter((id) => CASOS_POR_RAIZ[id] === undefined)).toEqual([]);
    expect(Object.keys(CASOS_POR_RAIZ).filter((id) => !ids.includes(id))).toEqual([]);
    for (const id of ids) {
      expect(CASOS_POR_RAIZ[id]!.pos.length, `${id}: positivos`).toBeGreaterThanOrEqual(2);
      expect(CASOS_POR_RAIZ[id]!.neg.length, `${id}: negativos`).toBeGreaterThanOrEqual(2);
    }
  });
  it("los ids de raiz son unicos", () => {
    const ids = RAICES_ARCO.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  for (const [id, casos] of Object.entries(CASOS_POR_RAIZ)) {
    it.each(casos.pos)(`${id} -> detecta: «%s»`, (frase) => {
      expect(raicesQueCoinciden(frase)).toContain(id);
    });
    it.each(casos.neg)(`${id} -> NO dispara nada: «%s»`, (frase) => {
      expect(detectArcoIntent(frase)).toBeNull();
    });
  }
});

describe("fuerza: lo ambiguo de restaurante NO registra ni descarta el mensaje", () => {
  it.each(["borra mi cuenta", "no me llamen", "tienen mis datos guardados?", "me opongo", "quiero privacidad"])("«%s» -> menu debil (el agente sigue con el pedido)", (frase) => {
    expect(detectArcoIntent(frase)).toMatchObject({ kind: "menu", fuerza: "debil" });
  });
  it("«borren mis datos de mi pedido» baja a debil (no se pierde el pedido); «borren mis datos» es fuerte", () => {
    expect(detectArcoIntent("borren mis datos de mi pedido")).toMatchObject({ kind: "menu", fuerza: "debil" });
    expect(detectArcoIntent("borren mis datos")).toMatchObject({ kind: "request", right: "cancelacion" });
  });
  it("explicito por derechos/privacidad -> menu fuerte; ARCO no especifica derecho", () => {
    expect(detectArcoIntent("quiero ejercer mis derechos ARCO")).toMatchObject({ kind: "menu", fuerza: "fuerte" });
    expect(detectArcoIntent("donde esta su aviso de privacidad")).toMatchObject({ kind: "menu", fuerza: "fuerte" });
  });
  it("datos de otra persona -> third_party, nunca solicitud", () => {
    expect(detectArcoIntent("borren los datos personales de mi esposa")).toEqual({ kind: "third_party" });
    expect(detectArcoIntent("quiero los datos personales de otra persona")).toEqual({ kind: "third_party" });
  });
  it("varios derechos en un mensaje: manda el mas amplio (cancelacion incluye frenar el uso)", () => {
    expect(detectArcoIntent("quiero que borren mis datos personales y que no los compartan")).toMatchObject({ kind: "request", right: "cancelacion" });
  });
});

describe("pronombres del imperativo: lo/los/la/las NUNCA son «yo» (lo que rompia el servicio)", () => {
  it.each(["olvidalo, mejor sin cebolla", "borralo", "eliminalo", "borrala", "borrenlos", "quitalo", "elimina lo anterior"])("«%s» -> null", (frase) => {
    expect(detectArcoIntent(frase)).toBeNull();
  });
  it.each(["borrame", "eliminame", "bórrenme", "sáquenme de su lista", "olvidame ya"])("«%s» (pronombre «me» pegado, sin objeto de pedido) -> ARCO", (frase) => {
    expect(detectArcoIntent(frase)).not.toBeNull();
  });
});

describe("contrato: nunca lanza con entradas que no son texto", () => {
  it.each([[0], [null], [undefined], [false], [true], [[]], [{}], [NaN], [Symbol.iterator.toString()], [() => "x"], [new Date(0)], [123n]])("detectArcoIntent(%s) -> null sin lanzar", (valor) => {
    expect(() => detectArcoIntent(valor as unknown as string)).not.toThrow();
    expect(detectArcoIntent(valor as unknown as string)).toBeNull();
  });
  it("cadena vacia, espacios, emojis y simbolos -> null", () => {
    for (const f of ["", "   ", "😀😀", "¿¿??!!", "\n\t"]) expect(detectArcoIntent(f)).toBeNull();
  });
  it("esOposicionDeContacto tambien es total", () => {
    for (const v of [0, null, undefined, false, [], {}]) expect(esOposicionDeContacto(v as unknown as string)).toBe(false);
  });
  it("entradas enormes no se cuelgan (sin backtracking catastrofico)", () => {
    const inicio = Date.now();
    for (const base of ["borren mis datos ", "no me manden ", "que ", "no quiero que ", "cuales son mis datos ", "me opongo "]) {
      detectArcoIntent(base.repeat(2000));
      detectArcoIntent(`${base}${"a ".repeat(5000)}`);
    }
    expect(Date.now() - inicio).toBeLessThan(10_000); // margen amplio: el CI con cobertura es ~10x mas lento; con el tope de largo local son milisegundos
  });
  it("una peticion al FINAL de un mensaje enorme se detecta igual (se conservan principio y final)", () => {
    expect(detectArcoIntent(`${"hola buenas ".repeat(1000)} borren mis datos`)).toMatchObject({ kind: "request", right: "cancelacion" });
    expect(detectArcoIntent(`borren mis datos ${"gracias ".repeat(1000)}`)).toMatchObject({ kind: "request", right: "cancelacion" });
  });
});

describe("unificado con la baja del webhook (detectarOptOut)", () => {
  it.each(["BAJA", "STOP", "stop", "no me escriban mas", "no mas mensajes", "darme de baja", "ya no quiero mensajes", "cancelar suscripcion", "dejar de recibir mensajes"])("«%s»: la baja exacta del webhook ES una oposicion de contacto para el detector", (frase) => {
    expect(detectarOptOut(frase)).toBe("baja");
    expect(detectArcoIntent(frase)).toMatchObject({ kind: "request", right: "oposicion", contacto: true });
    expect(esOposicionDeContacto(frase)).toBe(true);
  });
  it.each([
    "ya no me escriban",
    "no me manden publicidad",
    "dejen de mandarme promociones",
    "quiero desuscribirme",
    "ya no me llamen",
    "no quiero que me contacten",
  ])("«%s» (que el webhook NO reconoce como baja exacta) tambien frena el contacto", (frase) => {
    expect(detectarOptOut(frase)).toBeNull();
    expect(esOposicionDeContacto(frase)).toBe(true);
  });
  it.each(["borren mis datos", "quiero acceso a mis datos", "corrijan mi nombre", "no me manden salsa", "no me llamen cuando lleguen, toquen el timbre", "olvidense de mi", "saquenme de sus listas", "no me llamen"])("«%s» NO revoca el marketing (no es oposicion inequivoca)", (frase) => {
    expect(esOposicionDeContacto(frase)).toBe(false);
  });
});

describe("propiedad: suprimir + datos del titular nunca es null, con cualquier plantilla de pedido/factura", () => {
  const verbos = ["borren", "eliminen", "supriman", "borra", "elimina", "borrar", "eliminar", "ELIMINEN", "k borren", "q eliminen"];
  const objetos = ["mis datos", "mi info", "mi informacion", "mis datos personales", "mi telefono", "mi numero", "mi correo"];
  const plantillas = ["{v} {o}", "ya hice mi pedido, {v} {o}", "{o}, {v}", "necesito mi factura y {v} {o}", "hola buenas, {v} {o} ya no voy a pedir", "{v} {o} porfa"];
  const casos = verbos.flatMap((v) => objetos.flatMap((o) => plantillas.map((t) => t.replace("{v}", v).replace("{o}", o))));
  it("hay mas de 300 combinaciones", () => expect(casos.length).toBeGreaterThan(300));
  it("ninguna combinacion queda para el modelo", () => {
    expect(casos.filter((c) => detectArcoIntent(c) === null)).toEqual([]);
  });
  it("ninguna combinacion es third_party ni menu: es la solicitud de cancelacion", () => {
    const mal = casos.filter((c) => {
      const r = detectArcoIntent(c);
      return !(r !== null && (r.kind === "request" || (r.kind === "menu" && r.fuerza === "debil")));
    });
    expect(mal).toEqual([]);
  });
});

describe("propiedad: objetos de pedido nunca son ARCO con ningun verbo de suprimir", () => {
  const verbos = ["borra", "borren", "elimina", "eliminen", "quita", "quiten", "olvida", "cancela", "cancelen", "saca"];
  const objetos = ["el refresco", "la coca", "las papas", "el combo 2", "el numero 3", "la salsa", "el postre", "la orden de alitas", "el guacamole del pedido", "la cebolla y el cilantro"];
  const casos = verbos.flatMap((v) => objetos.map((o) => `${v} ${o}`));
  it("ninguna combinacion dispara", () => {
    expect(casos.filter((c) => detectArcoIntent(c) !== null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Corpus del revisor del PR #545, partido en DESARROLLO (se uso para afinar la capa regex) y CIEGO (nunca se leyo ni se afino contra el: mide la generalizacion real).
// Estos umbrales miden SOLO la capa regex determinista (alta precision). La RED DE SEGURIDAD con el modelo real se mide aparte, una vez, con
// scripts/medir-clasificador-arco (docs/ARCO-CLASIFICADOR.md): ahi se exige recall >= 98 % del sistema completo. Del lado de falsos positivos la regex SI se exige completa.
// Del corpus ciego NO se imprimen frases al fallar (solo conteos).
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const esFuerte = (r: ReturnType<typeof detectArcoIntent>): boolean => r !== null && (r.kind === "request" || (r.kind === "menu" && r.fuerza === "fuerte"));

describe("corpus del revisor #545: capa regex (umbrales fijos)", () => {
  const pDev = DEV_545.filter(([, e]) => e === "P").map(([f]) => f);
  const nDev = DEV_545.filter(([, e]) => e === "N").map(([f]) => f);
  const pCiego = CIEGO_545.filter(([, e]) => e === "P").map(([f]) => f);
  const nCiego = CIEGO_545.filter(([, e]) => e === "N").map(([f]) => f);

  it("tamanos: 225 frases en total (113 desarrollo + 112 ciego) y 11 rafagas", () => {
    expect(DEV_545.length + CIEGO_545.length).toBe(225);
    expect(RAFAGAS_DEV.length + RAFAGAS_CIEGO.length).toBe(11);
    expect(pDev.length + pCiego.length).toBe(112);
    expect(nDev.length + nCiego.length).toBe(104);
  });
  it("desarrollo: recall >= 95 % y 0 falsos positivos", () => {
    expect(pDev.filter((f) => detectArcoIntent(f) !== null).length / pDev.length).toBeGreaterThanOrEqual(0.95);
    expect(nDev.filter((f) => detectArcoIntent(f) !== null)).toEqual([]);
  });
  it("CIEGO: recall de la regex >= 88 % y falsos positivos <= 5 (los de main); sin imprimir frases", () => {
    const fn = pCiego.filter((f) => detectArcoIntent(f) === null).length;
    const fp = nCiego.filter((f) => detectArcoIntent(f) !== null).length;
    expect(1 - fn / pCiego.length).toBeGreaterThanOrEqual(0.88);
    expect(fp).toBeLessThanOrEqual(5);
  });
  it("las dos mitades juntas: falsos positivos <= 5 de 104 (umbral del revisor)", () => {
    expect([...nDev, ...nCiego].filter((f) => detectArcoIntent(f) !== null).length).toBeLessThanOrEqual(5);
  });
  it("senal FUERTE (la que toma el turno): 0 falsos positivos en 533, propio y desarrollo", () => {
    const negs = [...negativos, ...CORPUS_PROPIO.filter(([, e]) => e === "N").map(([f]) => f), ...nDev];
    expect(negs.filter((f) => esFuerte(detectArcoIntent(f)))).toEqual([]);
  });
  it("rafagas (cada mensaje por separado, como en produccion): al menos 8 de 11", async () => {
    let bien = 0;
    for (const [mensajes, etiqueta] of [...RAFAGAS_DEV, ...RAFAGAS_CIEGO]) {
      const detectado = (await intencionesPorMensaje(mensajes, undefined, "org")).length > 0;
      if ((etiqueta === "P") === detectado) bien += 1;
    }
    expect(bien).toBeGreaterThanOrEqual(8);
  });
});
