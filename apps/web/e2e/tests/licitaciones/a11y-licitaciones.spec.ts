// L-31 -- accesibilidad de cada pantalla del ciclo de licitaciones sobre el documento real: orden de encabezados, nombres accesibles y
// contraste de texto (chequeos propios, helpers/accesibilidad.ts: @axe-core/playwright no esta instalado y no se agrega una dependencia).
// Corre en claro y oscuro (@oscuro) y en escritorio y movil segun el proyecto. El estado de partida lo siembra el propietario contra la
// API simulada para que cada pantalla se pinte con datos (requisitos, mapeos, contrato, facturas), no vacia.
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { afirmarAccesibilidad } from "../../helpers/accesibilidad.ts";
import { ApiCiclo, BASE, TENDER_ID, rutaConvocatoria } from "../../helpers/ciclo-licitaciones.ts";

const PANTALLAS: ReadonlyArray<{ nombre: string; ruta: (rutaConvocatoria: (s?: string) => string) => string; pestana?: string }> = [
  { nombre: "convocatorias", ruta: () => `${BASE}/convocatorias` },
  { nombre: "ficha de la convocatoria", ruta: (r) => r() },
  { nombre: "go / no-go", ruta: (r) => r(), pestana: "Go / No-go" },
  { nombre: "requisitos de las bases", ruta: (r) => r("/requisitos") },
  { nombre: "propuesta tecnica y economica", ruta: (r) => r("/propuesta-tecnica") },
  { nombre: "cierre: checklist", ruta: (r) => r("/cierre") },
  { nombre: "cierre: aprobacion", ruta: (r) => r("/cierre"), pestana: "Aprobación" },
  { nombre: "cierre: paquete final", ruta: (r) => r("/cierre"), pestana: "Paquete final" },
  { nombre: "cierre: presentacion", ruta: (r) => r("/cierre"), pestana: "Presentación" },
  { nombre: "sala de guerra", ruta: (r) => r("/sala-guerra") },
  { nombre: "contrato", ruta: (r) => r("/contrato") },
  { nombre: "cobranza", ruta: (r) => r("/post-adjudicacion") },
  { nombre: "inconformidades", ruta: (r) => r("/post-adjudicacion"), pestana: "Inconformidades" },
];

test.describe("licitaciones: accesibilidad del ciclo @a11y", () => {
  test.setTimeout(180_000);

  test("cada pantalla del ciclo: encabezados en orden, controles con nombre y contraste @oscuro", async ({ page, iniciarSesion, mock, vigilante }) => {
    const api = new ApiCiclo(mock);
    await api.dejarGanada();
    await api.extraerRequisitos();
    await api.mapearTodo();
    await api.crearContrato();
    await api.llamar("POST", `/tenders/${TENDER_ID}/contract/invoices`, { concepto: "Primera estimación", amount: "12345.67", invoiceVerifiedOn: "2026-09-01" });
    await api.llamar("POST", `/tenders/${TENDER_ID}/inconformidad`, { hechos: ["Hecho."], agravios: ["Agravio."], pruebas: [], falloNotifiedOn: "2026-10-02", bajoTratados: false });
    await iniciarSesion("licitaciones", "owner");

    for (const pantalla of PANTALLAS) {
      await page.goto(pantalla.ruta(rutaConvocatoria));
      await afirmarPantallaSana(page, pantalla.nombre);
      if (pantalla.pestana) await page.getByRole("tab", { name: pantalla.pestana }).click();
      await expect(page.getByText("Cargando", { exact: false })).toHaveCount(0);
      await afirmarAccesibilidad(page, pantalla.nombre);
      await afirmarSinScrollHorizontal(page);
    }
    vigilante.verificar();
  });
});
