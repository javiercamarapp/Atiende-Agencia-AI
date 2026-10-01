// Ticket de cocina imprimible (PM PR-7): datos y HTML puros de @atiende/ui. Cubre
// canal/propina/salsas que viajan en `orders.notes`, caracteres especiales, nombres
// largos, decimales y un pedido grande.
import { describe, expect, it } from "vitest";
import {
  construirTicketCocina,
  folioTicket,
  pedidosPorImprimir,
  renderDocumentoTicketsCocina,
  renderTicketCocinaHtml,
  separarNotas,
  type TicketPedidoFuente,
} from "@atiende/ui";

const TZ = { timeZone: "America/Mexico_City" } as const;

function pedido(over: Partial<TicketPedidoFuente> = {}): TicketPedidoFuente {
  return {
    id: "3f2c9a10-aaaa-bbbb-cccc-0123456789ab",
    branch: "Centro",
    customerName: "Juan Pérez",
    customerPhone: "5511112222",
    customerAddress: "Calle Falsa 123, entre Reforma y Juárez. Portón negro",
    total: 345.5,
    items: [{ name: "Tacos al pastor", quantity: 3, tortilla: "maíz" }],
    notes: [
      "Sin cebolla en el pastor",
      "Complementos incluidos: salsa verde, salsa roja, limones.",
      "Complementos solicitados: salsa habanero.",
      "Canal: domicilio.",
      "Propina: $30.00 (no incluida en el total).",
    ].join("\n"),
    paymentMethod: "tarjeta",
    createdAt: "2026-09-19T16:05:00.000Z",
    estimatedDeliveryAt: "2026-09-19T16:45:00.000Z",
    ...over,
  };
}

describe("construirTicketCocina", () => {
  it("normaliza un pedido a domicilio con tarjeta", () => {
    const t = construirTicketCocina(pedido(), TZ);
    expect(t.folio).toBe("456789AB".slice(-6));
    expect(t.sucursal).toBe("Centro");
    expect(t.canal).toBe("domicilio");
    expect(t.horaPrometida).toBe("10:45");
    expect(t.direccion).toContain("Portón negro");
    expect(t.lineas).toEqual([{ cantidad: "3", nombre: "Tacos al pastor", modificadores: ["Tortilla: maíz"] }]);
    expect(t.salsas).toEqual(["Incluir: salsa verde, salsa roja, limones", "Extra: salsa habanero"]);
    expect(t.notas).toEqual(["Sin cebolla en el pastor"]);
    expect(t.formaPago).toBe("Tarjeta");
    expect(t.propina).toBe("$30.00");
    expect(t.total).toBe("$345.50");
    expect(t.reimpresion).toBe(0);
  });

  it("recoger: sin direccion aunque exista una guardada, y propina oculta con efectivo", () => {
    const t = construirTicketCocina(pedido({ notes: "Canal: recoger en sucursal.\nPropina: $20.00 (no incluida en el total).", paymentMethod: "efectivo" }), TZ);
    expect(t.canal).toBe("recoger");
    expect(t.canalEtiqueta).toBe("RECOGER EN SUCURSAL");
    expect(t.direccion).toBeNull();
    expect(t.propina).toBeNull();
    expect(t.notas).toEqual([]);
  });

  it("sin linea de canal: domicilio si hay direccion, no especificado si no", () => {
    expect(construirTicketCocina(pedido({ notes: null }), TZ).canal).toBe("domicilio");
    const sin = construirTicketCocina(pedido({ notes: null, customerAddress: null }), TZ);
    expect(sin.canal).toBe("sin_especificar");
    expect(sin.direccion).toBeNull();
  });

  it("sin hora prometida ni pago: lo dice en vez de inventar", () => {
    const t = construirTicketCocina(pedido({ estimatedDeliveryAt: null, paymentMethod: null }), TZ);
    expect(t.horaPrometida).toBeNull();
    expect(t.formaPago).toBe("Por definir");
    expect(renderTicketCocinaHtml(t)).toContain("sin hora prometida");
  });

  it("decimales: cantidades fraccionarias y total con separador de miles", () => {
    const t = construirTicketCocina(pedido({ total: 12345.678, items: [{ name: "Arrachera", quantity: 0.5 }, { name: "Refresco", quantity: 2 }] }), TZ);
    expect(t.lineas.map((l) => l.cantidad)).toEqual(["0.5", "2"]);
    expect(t.total).toBe("$12,345.68");
  });

  it("reimpresion se marca y nunca es negativa", () => {
    expect(construirTicketCocina(pedido(), { ...TZ, reimpresion: 2 }).reimpresion).toBe(2);
    expect(construirTicketCocina(pedido(), { ...TZ, reimpresion: -3 }).reimpresion).toBe(0);
  });

  it("zona horaria invalida cae a la del negocio sin lanzar", () => {
    expect(() => construirTicketCocina(pedido(), { timeZone: "No/Existe" })).not.toThrow();
  });

  it("folio estable y tolerante a ids raros", () => {
    expect(folioTicket("abc-123-def")).toBe("C123DEF".slice(-6));
    expect(folioTicket("---")).toBe("SIN-ID");
  });
});

describe("separarNotas", () => {
  it("la linea del servidor (ultima) gana sobre una igual escrita por el cliente", () => {
    const n = separarNotas("Canal: recoger.\nhola\nCanal: domicilio.");
    expect(n.canal).toBe("domicilio");
    expect(n.libres).toEqual(["hola"]);
  });
  it("complementos de cortesia omitidos", () => {
    expect(separarNotas("No enviar complementos de cortesía.").salsas).toEqual(["NO enviar complementos de cortesía"]);
  });
});

describe("renderTicketCocinaHtml", () => {
  it("escapa HTML y caracteres especiales (nunca ejecuta marcado del cliente)", () => {
    const t = construirTicketCocina(
      pedido({
        customerName: `<img src=x onerror="alert(1)"> Ñandú & "Hijos"`,
        items: [{ name: "Tacos <b>pastor</b> & piña ñ é ü 'x'", quantity: 1 }],
        notes: "<script>alert(1)</script>\nSin picante",
      }),
      TZ,
    );
    const html = renderTicketCocinaHtml(t);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>pastor");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Ñandú &amp; &quot;Hijos&quot;");
    expect(html).toContain("piña ñ é ü &#39;x&#39;");
  });

  it("elimina caracteres de control de impresora", () => {
    const t = construirTicketCocina(pedido({ customerName: "Ana\u001b@\u0007 Luz" }), TZ);
    expect(t.cliente).toBe("Ana@ Luz");
  });

  it("nombres largos no se truncan y el CSS permite partirlos", () => {
    const largo = "Hamburguesa-" + "superextra".repeat(20);
    const html = renderDocumentoTicketsCocina([construirTicketCocina(pedido({ items: [{ name: largo, quantity: 1 }], customerName: "N".repeat(150) }), TZ)]);
    expect(html).toContain(largo);
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("@page { size: 80mm auto; margin: 0; }");
  });

  it("marca la reimpresion en el encabezado", () => {
    const html = renderTicketCocinaHtml(construirTicketCocina(pedido(), { ...TZ, reimpresion: 1 }));
    expect(html).toContain("*** REIMPRESIÓN ***");
    expect(renderTicketCocinaHtml(construirTicketCocina(pedido(), { ...TZ, reimpresion: 3 }))).toContain("REIMPRESIÓN #3");
    expect(renderTicketCocinaHtml(construirTicketCocina(pedido(), TZ))).not.toContain("REIMPRESI");
  });

  it("propina solo aparece con tarjeta", () => {
    expect(renderTicketCocinaHtml(construirTicketCocina(pedido(), TZ))).toContain("Propina (tarjeta)");
    expect(renderTicketCocinaHtml(construirTicketCocina(pedido({ paymentMethod: "efectivo" }), TZ))).not.toContain("Propina");
  });

  it("pedido grande: 60 lineas, un salto de pagina por ticket y snapshot estable", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `Producto ${i + 1}`, quantity: (i % 5) + 1 }));
    const grande = construirTicketCocina(pedido({ items, total: 9876.5 }), TZ);
    const html = renderTicketCocinaHtml(grande);
    expect(html.match(/class="linea"/g)).toHaveLength(60);
    const doc = renderDocumentoTicketsCocina([grande, construirTicketCocina(pedido({ id: "otro-pedido-000001" }), TZ)]);
    expect(doc.match(/<article class="tk"/g)).toHaveLength(2);
    expect(doc).toContain("page-break-before: always");
  });

  it("snapshot del ticket completo a domicilio", () => {
    expect(renderTicketCocinaHtml(construirTicketCocina(pedido(), TZ))).toMatchSnapshot();
  });
});

describe("pedidosPorImprimir", () => {
  const p = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });
  it("solo pending sin imprimir, del mas antiguo al mas nuevo", () => {
    const r = pedidosPorImprimir(
      [p("c", "pending", "2026-01-03"), p("a", "pending", "2026-01-01"), p("b", "preparando", "2026-01-02"), p("d", "pending", "2026-01-04")],
      new Set(["d"]),
    );
    expect(r.map((x) => x.id)).toEqual(["a", "c"]);
  });
});
