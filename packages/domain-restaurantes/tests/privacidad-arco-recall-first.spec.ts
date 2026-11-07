// ARCO con RECALL PRIMERO: una solicitud de derechos que se pierde es el error grave; un menu de mas lo suaviza el propio menu. Corpus etiquetado (>= 200 frases),
// pruebas de propiedad (raiz de suprimir + datos/info/cuenta -> nunca null, con cualquier plantilla de pedido/factura) y el contrato publico sin cambios.
import { describe, expect, it } from "vitest";
import { detectArcoIntent } from "../src/privacidad/arco-intent.ts";
import { ARCO_MENU_REPLY } from "../src/privacidad/data-rights.ts";
import { CORPUS_ARCO } from "./arco-corpus.ts";

describe("corpus etiquetado", () => {
  it("tiene al menos 200 frases de las dos clases", () => {
    expect(CORPUS_ARCO.length).toBeGreaterThanOrEqual(200);
    expect(CORPUS_ARCO.filter(([, arco]) => arco).length).toBeGreaterThan(80);
    expect(CORPUS_ARCO.filter(([, arco]) => !arco).length).toBeGreaterThan(40);
  });
  it.each(CORPUS_ARCO.filter(([, arco]) => arco).map(([f]) => f))("ARCO, nunca queda para el modelo: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).not.toBeNull();
  });
  it("meta: 0 falsos negativos en todo el corpus", () => {
    const fn = CORPUS_ARCO.filter(([f, arco]) => arco && detectArcoIntent(f) === null);
    expect(fn).toEqual([]);
  });
  // Los NO ARCO claros (sin "mis datos" ni raiz de derechos) siguen sin molestar al cliente. Los falsos positivos con "mis datos" se asumen: van al menu, que no bloquea.
  const FP_ACEPTADOS = new Set(["mi direccion es calle 60 x 45 centro, borren la salsa de mi pedido"]); // verbo de borrar + direccion: al menu (recall primero)
  it.each(CORPUS_ARCO.filter(([f, arco]) => !arco && !FP_ACEPTADOS.has(f) && !/mis datos|datos mios|su sistema|olvid|saquen|den de baja/i.test(f)).map(([f]) => f))("no ARCO: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).toBeNull();
  });
});

describe("propiedad: suprimir + datos/info/cuenta nunca es null", () => {
  const verbos = ["borren", "eliminen", "supriman", "olviden", "borra", "elimina", "borrar", "eliminar", "bórrenme", "ELIMINEN", "borrenlos", "k borren", "q eliminen"];
  const objetos = ["mis datos", "mi info", "mi informacion", "mi cuenta", "mis datos personales"];
  const plantillas = ["{v} {o}", "ya hice mi pedido, {v} {o}", "{o}, {v}", "necesito mi factura y {v} {o}", "{v} {o} de mi orden, ya les pase todo"];
  const casos = verbos.flatMap((v) => objetos.flatMap((o) => plantillas.map((t) => t.replace("{v}", v).replace("{o}", o))));
  it("hay mas de 300 combinaciones", () => expect(casos.length).toBeGreaterThan(300));
  it("ninguna combinacion queda para el modelo", () => {
    const fallos = casos.filter((c) => detectArcoIntent(c) === null);
    expect(fallos).toEqual([]);
  });
});

describe("jerga de chat (k, q, kiero) y mayusculas", () => {
  it.each(["no kiero k tengan mi numero", "NO KIERO Q GUARDEN MI INFO", "ya no kiero k me tengan en su sistema", "no quiero q usen mis datos"])("«%s»", (f) => {
    expect(detectArcoIntent(f)).not.toBeNull();
  });
});

describe("mezcla con pedido o factura sin nombrar privacidad: menu, no solicitud adivinada", () => {
  it.each(["borren mis datos de mi pedido", "ya les di mis datos y quiero que los borren", "borren mis datos y facturame"])("«%s» -> menu", (f) => {
    expect(detectArcoIntent(f)).toEqual({ kind: "menu" });
  });
  it("con privacidad explicita sigue siendo la solicitud concreta", () => {
    expect(detectArcoIntent("quiero que eliminen mis datos personales, ya hice un pedido")).toEqual({ kind: "request", right: "cancelacion" });
  });
  it("datos de otra persona siguen siendo third_party", () => {
    expect(detectArcoIntent("borren los datos personales de mi esposa")).toEqual({ kind: "third_party" });
  });
});

describe("el menu suaviza los falsos positivos sin bloquear el pedido", () => {
  it("dice que se puede seguir con el pedido o la factura", () => {
    expect(ARCO_MENU_REPLY).toMatch(/pedido o pedir su factura/);
    expect(ARCO_MENU_REPLY).toMatch(/no se pierde/);
    expect(ARCO_MENU_REPLY).not.toMatch(/\b(tu|te|dime)\b/i); // trato de usted
  });
});
