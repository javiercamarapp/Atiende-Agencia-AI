// i18n ES/EN: sanidad del trinquete (scripts/i18n-guard). Que detecte lo que una persona lee, que no confunda rutas/clases/claves
// con texto, que respete `t()` e `i18n-ignorar`, y que el veredicto suba/baje como un trinquete.
import { describe, expect, it } from "vitest";
import { detectar } from "../../../scripts/i18n-guard/detector.ts";
import { evaluar } from "../../../scripts/i18n-guard/guard.ts";

const textos = (codigo: string) => detectar(codigo, "x.tsx").map((h) => h.texto);

describe("detector de textos escritos a mano", () => {
  it("detecta texto JSX, atributos visibles y propiedades label/title", () => {
    expect(textos(`export const A = () => <div title="Ayuda"><h1>Resumen</h1><input placeholder="Buscar" aria-label="Buscar pedidos" /></div>;`)).toEqual([
      "Ayuda",
      "Resumen",
      "Buscar",
      "Buscar pedidos",
    ]);
    expect(textos(`const s = [{ to: "/a", label: "Pedidos", icon: X }, { title: "Operación" }];`)).toEqual(["Pedidos", "Operación"]);
  });

  it("detecta nombres compuestos y valores por omision de props", () => {
    expect(textos(`function V({ volverEtiqueta = "Volver al panel" }) { return null; }\nconst x = { confirmLabel: "Borrar" };`)).toEqual(["Volver al panel", "Borrar"]);
  });

  it("detecta literales en {} hijos de JSX y en ramas de un ternario", () => {
    expect(textos(`const A = ({ ok }) => <p>{ok ? "Listo" : "Pendiente"}</p>;`)).toEqual(["Listo", "Pendiente"]);
  });

  it("detecta cualquier literal con letras del espanol", () => {
    expect(textos(`throw new Error("No se encontró la sucursal");`)).toEqual(["No se encontró la sucursal"]);
  });

  it("ignora rutas, clases, claves, tipos, imports, t() y console", () => {
    expect(
      textos(`import { X } from "lucide-react";
        type Fase = "cargando" | "error";
        const r = { "Operación": 1 };
        const c = <div className="flex items-center" data-testid="pedidos" />;
        const u = \`/restaurantes/\${slug}/pedidos\`;
        const v = t("nav.resumen", { nombre: "Más" });
        console.warn("falló");`),
    ).toEqual([]);
  });

  it("respeta // i18n-ignorar en la linea anterior", () => {
    expect(textos(`// i18n-ignorar: mensaje que el agente envia al cliente por WhatsApp (va en espanol)\nconst m = "¡Gracias por tu pedido!";`)).toEqual([]);
  });

  it("trinquete: sube falla, baja pide bajar el baseline, igual pasa", () => {
    const h = (n: number) => Array.from({ length: n }, (_, i) => ({ linea: i, texto: "x" }));
    expect(evaluar([{ ruta: "a", hallazgos: h(2), permitido: 2 }]).ok).toBe(true);
    expect(evaluar([{ ruta: "a", hallazgos: h(3), permitido: 2 }]).suben.map((r) => r.ruta)).toEqual(["a"]);
    const baja = evaluar([{ ruta: "a", hallazgos: h(1), permitido: 2 }]);
    expect(baja.ok).toBe(false);
    expect(baja.bajan.map((r) => r.ruta)).toEqual(["a"]);
  });
});
