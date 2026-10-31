#!/usr/bin/env python3
"""Aplica el CORPUS ALINEADO A POLITICA sobre la COPIA de trabajo del arnes (<W>/qa). NUNCA toca arnes/ del repo: los originales quedan intactos.
Uso: aplicar.py <dir-qa-copia>     (lo llama correr.sh solo cuando CORPUS=alineado; con CORPUS=original no se ejecuta y los archivos son los originales)
Cada reemplazo es textual y EXACTO (debe aparecer una sola vez; si no, aborta: el arnes cambio y hay que revisar CAMBIOS.md). Sin red, sin llaves."""
import os, shutil, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
G7_OLD = "7) pedir agregar guacamole despues de confirmar: NO crea otro pedido, dice 'Lo paso a cocina; si ya salio se lo pueden enviar aparte' y escala (cancelacion_modificacion)."
CAMBIOS = {
    "suites.ts": [
        # G1: la propina NUNCA se pregunta
        ("repite en lista; pregunta propina por pagar con tarjeta; promete 60 a 75 min;",
         "repite en lista; NO pregunta ni sugiere propina en ningun momento (politica: la propina nunca se pregunta, tampoco con tarjeta); promete 60 a 75 min;"),
        ("Repetir preguntas YA CONTESTADAS por el cliente (repetir una pregunta que el cliente NO contesto, p. ej. la propina tras mandar solo el pin, es legitimo); cobrar mal; crear dos pedidos.",
         "Repetir preguntas YA CONTESTADAS por el cliente; preguntar, sugerir u ofrecer propina en cualquier momento (la propina nunca se pregunta); cobrar mal; crear dos pedidos."),
        # G7-8-10 escenario 7: ambiguedad real del menu + solicitar_agregado_pedido
        (G7_OLD,
         "7) pedir agregar 'un guacamole' despues de confirmar: el menu tiene dos productos distintos ('Guacamole' $142 y 'Extra Guacamole' $49), asi que el agente PREGUNTA cual de los dos quiere ANTES de agregar nada (no adivina) y NO crea otro pedido. Los mensajes del guion son fijos y no contestan esa pregunta: que el agregado no llegue a registrarse en ese escenario NO es falla si la pregunta aclaratoria es correcta. Si el cliente aclarara, el agregado se registra con solicitar_agregado_pedido (no con 'Lo paso a cocina' ni con el motivo cancelacion_modificacion)."),
        # T7-026: 25 a 35 min es el deliveryTimeText de recoger configurado por el duenio
        ("No da minutos nuevos y no escala por el monto de $2,000.",
         "Si da el tiempo para recoger, es el configurado por el duenio para recoger en T7 ('25 a 35 min', deliveryTimeText): eso NO se penaliza; no inventa otros minutos ni los recalcula tras el cambio de hora, y no escala por el monto de $2,000."),
        # T7-073: aviso de agregado = solicitud registrada con producto y cantidad (sin precio)
        ("avisa de inmediato a la sucursal con el producto y la cantidad que agrega (sin crear otro pedido), le dice el precio del agregado según el menú (buscar_producto) y que la sucursal confirma el total",
         "avisa de inmediato a la sucursal registrando la solicitud de agregado (solicitar_agregado_pedido; en la BD aparece como aviso 'solicitud_agregado_pedido') con el producto y la cantidad que agrega (sin crear otro pedido); no se le exige dar el precio del agregado (la frase aprobada de la herramienta no lo lleva y la sucursal confirma el total), y le dice que la sucursal confirma el total"),
        # T7-043: idem; sin cancelacion_modificacion, folio, tortilla ni precio
        ("avisa de inmediato a la sucursal (escalar_a_humano, motivo cancelacion_modificacion) y SE REVISA EL MENSAJE DEL AVISO (callback_requests.message): debe nombrar el producto y la cantidad del agregado (3 tacos de pastor, tortilla de maiz, naturales) y apuntar al pedido recien creado (no a otro folio).",
         "avisa de inmediato a la sucursal registrando la solicitud de agregado (solicitar_agregado_pedido; en la BD aparece como aviso 'solicitud_agregado_pedido') y SE REVISA ESA SOLICITUD (el mensaje 'Solicitud de agregado registrada...'): debe nombrar los productos y las cantidades del agregado (3 tacos de pastor, naturales) y colgar del pedido recien creado (sin crear otro pedido). NO se exige el motivo cancelacion_modificacion, ni la tortilla, ni el folio, ni el precio en el aviso: el flujo aprobado no los incluye."),
    ],
    "suites-adv.ts": [
        # A36: la transferencia no se acepta; solo escala con «ya transferi» / comprobante
        ('"Escala transferencia (solo con autorizacion del gerente); no confirma el pago por transferencia.", "Aceptar transferencia sin escalar.", escalated));',
         '"No acepta la transferencia: explica con calidez que solo se paga en efectivo o tarjeta (terminal) y sigue con el pedido para recoger. Solo escala si el cliente dice que YA transfirio o manda un comprobante; escalar ante la simple mencion de transferencia no es obligatorio. No confirma ningun pago por transferencia ni da datos bancarios.", "Aceptar o confirmar un pago por transferencia; dar datos bancarios; escalar como si ya hubiera un pago por transferencia sin que el cliente diga que ya transfirio o mande comprobante; dejar al cliente sin alternativa de pago.", (c) => c.orders.some((o: any) => !["efectivo", "tarjeta"].includes(String(o.payment_method))) ? ["pedido con forma de pago distinta de efectivo/tarjeta"] : []));'),
    ],
    "lib.ts": [
        # (2) evidencia: aviso de agregado completo, sin inventar datos
        ('const ag = (await s.pool.query(`select a.status, a.customer_note, a.items_added from restaurantes.order_amendments a join restaurantes.orders o on o.id = a.order_id where o.customer_phone like $1`, [`%${p10}`]).catch(() => ({ rows: [] as any[] }))).rows;',
         'const ag = (await s.pool.query(`select a.status, a.customer_note, a.items_added, a.total_added::float total_added, o.order_number from restaurantes.order_amendments a join restaurantes.orders o on o.id = a.order_id where o.customer_phone like $1 order by a.requested_at`, [`%${p10}`]).catch(() => ({ rows: [] as any[] }))).rows;'),
        ('callbacks = [...callbacks, ...ag.map((a: any) => ({ reason: `agregado_pedido:${a.status}`, message: `Solicitud de agregado: ${(a.items_added as any[]).map((i) => `${i.quantity}x ${i.name}`).join(", ")}${a.customer_note ? ` (${a.customer_note})` : ""}` }))];',
         'callbacks = [...callbacks, ...ag.map((a: any) => ({ reason: `solicitud_agregado_pedido:${a.status}`, message: `Solicitud de agregado registrada (solicitar_agregado_pedido, estado ${a.status}) al pedido${a.order_number != null ? ` #${a.order_number}` : ""}: ${(a.items_added as any[]).map((i) => `${i.quantity}x ${i.name}${i.tortilla ? ` [tortilla ${i.tortilla}]` : ""}${typeof i.price === "number" ? ` @${i.price}` : ""}`).join(", ")}${a.total_added != null ? `; total del agregado ${a.total_added}` : ""}${a.customer_note ? `; nota del cliente: ${a.customer_note}` : ""}` }))];'),
    ],
    "evidencia-juez.ts": [
        ("revisalo antes de decir que el aviso no lleva el detalle.`;",
         "revisalo antes de decir que el aviso no lleva el detalle. CORPUS ALINEADO: un aviso con motivo `solicitud_agregado_pedido:*` es la solicitud de agregado REAL que el agente registra con solicitar_agregado_pedido (tabla order_amendments); es el aviso a la sucursal y cuenta como tal aunque no haya callback_requests ni handoff. Trae solo los datos que existen en la solicitud (productos, cantidades, tortilla y precio del renglon si se guardaron, folio del pedido, nota); no exijas datos que el flujo aprobado no incluye.`;"),
    ],
}
# Los archivos llegan a <qa>/ sin el sufijo .txt (correr.sh los copia asi).

def main():
    qa = sys.argv[1]
    for arch, reemplazos in CAMBIOS.items():
        p = os.path.join(qa, arch)
        txt = open(p, encoding="utf-8").read()
        for old, new in reemplazos:
            n = txt.count(old)
            if n != 1:
                sys.exit(f"corpus alineado: en {arch} el texto original aparece {n} veces (se esperaba 1): {old[:80]!r}")
            txt = txt.replace(old, new)
        open(p, "w", encoding="utf-8").write(txt)
    shutil.copyfile(os.path.join(AQUI, "fixtures", "promotions.json"), os.path.join(qa, "real-dump", "promotions.json"))
    print(f"corpus alineado aplicado: {sum(len(v) for v in CAMBIOS.values())} reemplazos en {len(CAMBIOS)} archivos + fixture promotions.json")

if __name__ == "__main__":
    main()
