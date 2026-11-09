// @vitest-environment jsdom
//
// «x de y fuentes» al pie de una respuesta: se pinta SOLO con la cobertura que mando el servidor para esa respuesta (consultas que
// corrieron y cuantas trajeron datos); sin ella (respuesta guardada, vieja o sin consultas) o con una forma imposible, no se pinta nada.
import { afterEach, describe, expect, it } from "vitest";
import { CopilotoMensajeVista } from "../src/components/copiloto/CopilotoMensaje";
import type { CopilotoMensaje } from "../src/components/copiloto/tipos";
import { limpiarDom, montar, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const BASE: CopilotoMensaje = {
  id: "a1",
  role: "assistant",
  text: "Vendiste 10",
  status: "ok",
  sources: [{ tool: "ventas_por_dia", source: "Pedidos", scopeLabel: "todas tus sucursales" }],
};

function pie(m: CopilotoMensaje): string | null {
  montado = montar(
    <CopilotoMensajeVista mensaje={m} esUltima={false} conversacionId={undefined} transporte={transporteFalso().t} rutasFuente={undefined} sugerenciasAlternas={[]} ocupado={false} onRegenerar={() => undefined} onPreguntar={() => undefined} />,
  );
  return montado.container.querySelector('[data-testid="copiloto-cobertura"]')?.textContent ?? null;
}

describe("cobertura de fuentes al pie de la respuesta", () => {
  it("2 de 3 fuentes con datos", () => {
    expect(pie({ ...BASE, cobertura: { conDatos: 2, consultadas: 3 } })).toContain("2 de 3 fuentes con datos");
  });

  it("singular: 1 de 1 fuente con datos", () => {
    expect(pie({ ...BASE, cobertura: { conDatos: 1, consultadas: 1 } })).toContain("1 de 1 fuente con datos");
  });

  it("sin cobertura del servidor no se inventa nada", () => {
    expect(pie(BASE)).toBeNull();
  });

  it("una forma imposible (mas con datos que consultadas) no se pinta", () => {
    expect(pie({ ...BASE, cobertura: { conDatos: 3, consultadas: 2 } })).toBeNull();
  });
});
