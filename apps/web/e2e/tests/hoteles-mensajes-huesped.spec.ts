// H-P3-03 -- e2e de navegador (API simulada): configurar los mensajes automaticos al huesped, ver el historial y comprobar que el PRIMER mensaje del agente
// lleva el enlace del aviso de privacidad. Demuestra que la SPA hace lo correcto con respuestas bien formadas; la logica real (canal, idempotencia, retencion)
// la cubren el API, el dominio y el verify de Postgres real.
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

test.describe("hoteles: mensajes automaticos al huesped", () => {
  test("owner: ve los eventos, el aviso honesto sin credencial de Meta y el historial con el estado real de cada envio", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/mensajeria`);
    await expect(page.getByText("Mensajes automáticos", { exact: true })).toBeVisible();
    await expect(page.getByText("requiere credencial de WhatsApp (Meta); se enviará por correo")).toBeVisible();
    await expect(page.getByText("Solo correo", { exact: true })).toBeVisible();
    // En movil las tablas se pintan como tarjetas (DataTable vista "auto"): se afirma por texto, valido en ambas vistas.
    await expect(page.getByText("Pre-reserva aprobada").first()).toBeVisible();
    await expect(page.getByText("Pre-llegada (antes del check-in)").first()).toBeVisible();
    await expect(page.getByText("Enviado", { exact: true })).toBeVisible();
    await expect(page.getByText("No enviado", { exact: true })).toBeVisible();
    await expect(page.getByText("El huésped no dejó teléfono ni correo.")).toBeVisible();
    expect(vigilante.sinFixture, "Mensajeria pidio una ruta que la API simulada no conoce").toEqual([]);
    vigilante.verificar();
  });

  test("owner: activar la pre-llegada, fijar 24 h y el enlace de reseña se escribe por la API y se refleja al recargar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/mensajeria`);
    const interruptor = page.getByRole("switch", { name: "Pre-llegada (antes del check-in): activo" });
    await expect(interruptor).not.toBeChecked();
    await interruptor.click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/mensajes-huesped/pre_llegada" })).length).toBe(1);
    await expect(interruptor).toBeChecked();

    await page.getByRole("button", { name: "Horas de pre-llegada" }).click();
    const d = dialogo(page, /Horas de pre-llegada/);
    await expect(d).toBeVisible();
    await d.getByLabel("Horas antes del check-in").fill("24");
    await d.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText("24 h antes del check-in")).toBeVisible();

    await page.getByRole("button", { name: "Enlace de reseña" }).click();
    const r = dialogo(page, /Enlace de reseña/);
    await r.getByLabel(/Enlace de reseña/).fill("http://inseguro.example.com");
    await expect(r.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled();
    await r.getByLabel(/Enlace de reseña/).fill("https://g.page/r/ejemplo/review");
    await r.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(r).toBeHidden();

    const puts = await mock.buscar({ metodo: "PUT", ruta: "/mensajes-huesped/" });
    expect(puts.map((x) => x.cuerpo)).toContainEqual({ activo: true, horasAntes: 24, resenaUrl: null });
    expect(puts.map((x) => x.cuerpo)).toContainEqual({ activo: false, horasAntes: null, resenaUrl: "https://g.page/r/ejemplo/review" });

    await page.reload();
    await expect(page.getByText("24 h antes del check-in")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Pre-llegada (antes del check-in): activo" })).toBeChecked();
    vigilante.verificar();
  });

  test("owner: registrar y quitar la plantilla HSM de un evento; Volver no escribe", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/mensajeria`);
    await expect(page.getByText("Sin plantilla: sale por correo").first()).toBeVisible();
    await page.getByRole("button", { name: "Elegir plantilla" }).first().click();
    const d = dialogo(page, /Plantilla de WhatsApp/);
    await d.getByLabel("Nombre en Meta").fill("hotel_hold_aprobado");
    await d.getByLabel("Variables, en orden").fill("nombre, hotel, llegada");
    await d.getByLabel("Estado en Meta").selectOption("aprobada");
    await d.getByRole("button", { name: "Guardar plantilla" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText("hotel_hold_aprobado")).toBeVisible();
    await expect(page.getByText("Aprobada", { exact: true })).toBeVisible();
    const put = (await mock.buscar({ metodo: "PUT", ruta: "/mensajes-huesped/hold.aprobado/plantilla" }))[0]!;
    expect(put.cuerpo).toEqual({ nombre: "hotel_hold_aprobado", idioma: "es_MX", variables: ["nombre", "hotel", "llegada"], estado: "aprobada" });

    const quitar = page.getByRole("button", { name: "Quitar plantilla" });
    await afirmarCancelarNoEscribe(page, mock, quitar, { nombre: "Quitar la plantilla", botonCancelar: "Volver", verificarFoco: false });
    await quitar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Quitar plantilla" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "DELETE", ruta: "/mensajes-huesped/hold.aprobado/plantilla" })).length).toBe(1);
    await expect(page.getByText("Sin plantilla: sale por correo").first()).toBeVisible();
    vigilante.verificar();
  });

  test("conversaciones: el PRIMER mensaje del agente lleva la linea de IA y el enlace del aviso de privacidad del hotel; el siguiente no", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/conversaciones`);
    await page.getByText("Hola, quiero reservar").first().click();
    const mensajes = page.getByRole("region", { name: "Mensajes" });
    const primero = mensajes.getByText("Este número es atendido por un asistente automático");
    await expect(primero).toContainText(`Aviso de privacidad: ${hoteles.avisoUrl}`);
    await expect(mensajes.getByText("Perfecto, reviso disponibilidad para esas fechas.")).not.toContainText("Aviso de privacidad");
    vigilante.verificar();
  });
});
