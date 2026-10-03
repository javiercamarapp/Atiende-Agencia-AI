// C-11 -- bandeja de conversaciones de WhatsApp de citas con handoff a humano, contra la API simulada de e2e (nunca habla con un WhatsApp real):
// tomar, responder y cerrar con "Cancelar" que NO ejecuta. Las escrituras se verifican en el registro de peticiones del mock.
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

test.describe("conversaciones de citas @humo", () => {
  test("owner: tomar la conversacion, responder y devolverla; el servidor recibe cada accion real", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`/citas/${citas.orgSlug}/conversaciones`);
    await afirmarPantallaSana(page, "bandeja de conversaciones");

    // La bandeja muestra el telefono enmascarado y la marca de crisis de la conversacion que pidio una persona.
    const filaCrisis = page.locator("[data-conversation-id='cnv-2']").first();
    await expect(filaCrisis).toContainText("***0202");
    await expect(filaCrisis).toContainText("Crisis");

    const fila = page.locator("[data-conversation-id='cnv-1']").first();
    await expect(fila).toContainText("Con el agente");
    await fila.click();
    await page.getByRole("button", { name: "Tomar conversación" }).click();
    await expect(page.getByText("La conversación es tuya: el agente ya no responde.")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/conversaciones/cnv-1/tomar" })).length).toBe(1);
    await expect(fila).toContainText("Atendiendo una persona");

    await page.getByRole("button", { name: "Responder" }).click();
    const d = dialogo(page, "Responder por WhatsApp");
    await expect(d).toBeVisible();
    await d.getByRole("textbox").fill("Con gusto le ayudo a mover su cita");
    await d.getByRole("button", { name: "Enviar respuesta" }).click();
    await expect(page.getByText("Respuesta en cola")).toBeVisible();
    const respuestas = await mock.buscar({ metodo: "POST", ruta: "/responder" });
    expect(respuestas).toHaveLength(1);
    expect(respuestas[0]!.cuerpo).toEqual({ texto: "Con gusto le ayudo a mover su cita" });
    await expect(page.getByText("Con gusto le ayudo a mover su cita")).toBeVisible();

    await page.getByRole("button", { name: "Devolver al agente" }).click();
    await expect(page.getByText("Devuelta al agente: vuelve a responder.")).toBeVisible();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/devolver" })).length).toBe(1);
    vigilante.verificar();
  });

  test("cerrar la conversacion: Cancelar y Escape no escriben; confirmar hace un POST /cerrar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`/citas/${citas.orgSlug}/conversaciones`);
    await page.locator("[data-conversation-id='cnv-1']").first().click();
    await page.getByRole("button", { name: "Tomar conversación" }).click();
    await expect(page.getByRole("button", { name: "Cerrar conversación" })).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, page.getByRole("button", { name: "Cerrar conversación" }), { nombre: "Cerrar la conversación", botonCancelar: "Cancelar", verificarFoco: false });
    expect(await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).toHaveLength(0);

    await page.getByRole("button", { name: "Cerrar conversación" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cerrar conversación" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).length).toBe(1);
    await expect(page.getByText("Conversación cerrada.")).toBeVisible();
    vigilante.verificar();
  });

  test("staff: toma la conversacion pendiente por crisis y queda habilitado para responder", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas", "staff");
    await page.goto(`/citas/${citas.orgSlug}/conversaciones`);
    const fila = page.locator("[data-conversation-id='cnv-2']").first();
    await expect(fila).toContainText("Pide una persona");
    await fila.click();
    await expect(page.getByRole("button", { name: "Tomar conversación" })).toBeVisible();
    await page.getByRole("button", { name: "Tomar conversación" }).click();
    await expect(page.getByRole("button", { name: "Responder" })).toBeVisible();
    vigilante.verificar();
  });
});
