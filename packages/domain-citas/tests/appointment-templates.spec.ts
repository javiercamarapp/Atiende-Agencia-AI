// Pruebas de las plantillas de correo de citas — port de
// citas-reservaciones/supabase/functions/_shared/emails/plantillas-citas.test.ts.
// Cubre renderizado correcto del HTML y que el escape de datos del cliente evita
// XSS real (el nombre del cliente es el dato dinámico más sensible — llega tal
// cual lo transcribió el agente de voz/WhatsApp o lo tecleó alguien en el panel,
// nunca es un dato de confianza).
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/emails/layout.ts";
import { correoCitaCancelada, correoCitaCreada, correoCitaModificada, correoCitaReagendada, correoCitaRecordatorio, type CitaCorreo } from "../src/emails/appointment-templates.ts";

const BASE: CitaCorreo = {
  clienteNombre: "Juan Pérez",
  tenantNombre: "Consultorio Dental Sonrisa",
  servicioNombre: "Limpieza dental",
  proveedorNombre: "Dra. López",
  fechaHoraTexto: "miércoles 10 de septiembre, 10:00 a.m.",
};

describe("escapeHtml", () => {
  it("escapa <, >, &, comillas dobles y simples", () => {
    expect(escapeHtml(`<script>alert('x')</script> & "cita" 'grande'`)).toBe("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;cita&quot; &#39;grande&#39;");
  });
});

describe("plantillas de correo — renderizado correcto por evento", () => {
  it("correoCitaCreada: el HTML trae servicio, proveedor y fecha/hora reales", () => {
    const { asunto, html, texto } = correoCitaCreada(BASE);
    expect(html).toContain("Tu cita quedó agendada");
    expect(html).toContain("Limpieza dental");
    expect(html).toContain("Dra. López");
    expect(html).toContain("miércoles 10 de septiembre, 10:00 a.m.");
    expect(html).toContain("Juan Pérez");
    expect(asunto).toContain("Consultorio Dental Sonrisa");
    expect(texto).toContain("Limpieza dental");
    expect(texto).toContain("Dra. López");
  });

  it("correoCitaRecordatorio: menciona 'mañana' y trae el detalle real de la cita", () => {
    const { asunto, html, texto } = correoCitaRecordatorio(BASE);
    expect(html).toContain("Recordatorio");
    expect(html).toContain("mañana");
    expect(html).toContain("Limpieza dental");
    expect(asunto.toLowerCase()).toContain("recordatorio");
    expect(texto).toContain("mañana");
  });

  it("correoCitaCancelada: menciona la cancelación real", () => {
    const { asunto, html } = correoCitaCancelada(BASE);
    expect(html).toContain("cancelada");
    expect(asunto).toContain("cancelada");
  });

  it("correoCitaReagendada: incluye la fecha anterior Y la nueva", () => {
    const { html, texto } = correoCitaReagendada({ ...BASE, fechaHoraAnteriorTexto: "lunes 8 de septiembre, 9:00 a.m." });
    expect(html).toContain("lunes 8 de septiembre, 9:00 a.m.");
    expect(html).toContain(BASE.fechaHoraTexto);
    expect(texto).toContain("lunes 8 de septiembre, 9:00 a.m.");
  });

  it("correoCitaModificada: menciona la actualización real", () => {
    const { asunto, html } = correoCitaModificada(BASE);
    expect(html).toContain("actualizó");
    expect(asunto).toContain("actualizada");
  });
});

describe("XSS real — el nombre del cliente NUNCA se confía", () => {
  it("correoCitaCreada: un nombre de cliente con <script> NUNCA aparece sin escapar en el HTML", () => {
    const { html } = correoCitaCreada({ ...BASE, clienteNombre: `<script>alert('robo de cookies')</script>` });
    expect(html.includes(`<script>alert('robo de cookies')</script>`)).toBe(false);
    expect(html).toContain("&lt;script&gt;");
  });

  it("correoCitaCancelada: comillas y ampersands en el nombre del cliente se escapan", () => {
    const { html } = correoCitaCancelada({ ...BASE, clienteNombre: `Juan "El Grande" & Cía` });
    expect(html).toContain("&quot;El Grande&quot;");
    expect(html).toContain("&amp;");
    expect(html.includes(`Juan "El Grande" & Cía`)).toBe(false);
  });

  it("correoCitaReagendada: inyección vía servicioNombre/proveedorNombre también se escapa (tabla de detalle)", () => {
    const { html } = correoCitaReagendada({ ...BASE, servicioNombre: `<img src=x onerror=alert(1)>`, proveedorNombre: `<b>proveedor</b>`, fechaHoraAnteriorTexto: "lunes" });
    expect(html.includes("<img src=x onerror=alert(1)>")).toBe(false);
    expect(html.includes("<b>proveedor</b>")).toBe(false);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
  });
});
