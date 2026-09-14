# Generador del golden-set numérico de devolución de IVA (Fase 6 despachos) —
# mismo mecanismo que golden_gen_declaraciones.py/golden_gen_migracion_catalogo.py:
# se ejecuta UNA VEZ contra el intérprete real del repo `despachos` para producir
# golden-devolucion-iva-output.json, que queda congelado y versionado junto a
# este script.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_devolucion_iva.py > golden-devolucion-iva-output.json
#
# Cubre: generar_diot (prorrateo + agrupación por RFC), iva_acreditable_
# efectivamente_pagado (gate LIVA Art. 5-III), conciliar_facturas_diot,
# conciliar_diot_declaracion (tolerancia relativa 5%), conciliar_declaracion_
# saldo (tolerancia absoluta 0.01), calcular_saldo_favor, calcular_monto_
# devolucion, validar_congruencia_diot_cfdi_declaracion (umbral $10,001,
# tolerancia $1.00), validate_clabe (dígito verificador módulo 10 3-7-1),
# sumar_dias_habiles/calcular_fecha_limite_resolucion (Art. 22 CFF).
import sys
import json

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.devolucion_iva.service import (  # noqa: E402
    generar_diot,
    conciliar_facturas_diot,
    conciliar_diot_declaracion,
    conciliar_declaracion_saldo,
    calcular_saldo_favor,
    calcular_monto_devolucion,
    validar_congruencia_diot_cfdi_declaracion,
    sumar_dias_habiles,
    calcular_fecha_limite_resolucion,
)
from b2b_ai.features.devolucion_iva.models import FacturaCFDI, DIOTEntry, DeclaracionMensual  # noqa: E402
from b2b_ai.features.devolucion_iva.validators import validate_clabe  # noqa: E402

out = {}


def f(uuid, rfc_emisor, subtotal, iva, proporcionalidad=1.0, fecha="2026-01-15", referencia_complemento_pago=None, tipo="Ingreso"):
    return FacturaCFDI(
        uuid=uuid, rfc_emisor=rfc_emisor, rfc_receptor="AAA010101AAA",
        fecha=fecha, subtotal=subtotal, iva=iva, total=subtotal + iva,
        tipo=tipo, proporcionalidad=proporcionalidad,
        referencia_complemento_pago=referencia_complemento_pago,
    )


# --- generar_diot: agrupación por RFC + prorrateo ---
facturas_diot = [
    f("11111111-1111-1111-1111-111111111111", "PROV010101AAA", 1000.0, 160.0),
    f("22222222-2222-2222-2222-222222222222", "PROV010101AAA", 2000.0, 320.0),
    f("33333333-3333-3333-3333-333333333333", "PROV020202BBB", 1600.0, 256.0, proporcionalidad=0.5),
]
entries = generar_diot(facturas_diot)
out["generar_diot_agrupado"] = {
    "entrada": [{"uuid": x.uuid, "rfc_emisor": x.rfc_emisor, "subtotal": x.subtotal, "iva": x.iva, "proporcionalidad": x.proporcionalidad} for x in facturas_diot],
    "resultado": [
        {"rfc_tercero": e.rfc_tercero, "tipo_operacion": e.tipo_operacion, "monto_neto": e.monto_neto, "iva_trasladado": e.iva_trasladado, "iva_acreditable": e.iva_acreditable, "folios_fiscales": e.folios_fiscales}
        for e in entries
    ],
}

# --- iva_acreditable_efectivamente_pagado: gate LIVA Art. 5-III ---
casos_efectivo = [
    ("sin_rep", f("aaaaaaaa-0000-0000-0000-000000000001", "X", 1000.0, 160.0, proporcionalidad=0.5, referencia_complemento_pago=None)),
    ("con_rep", f("aaaaaaaa-0000-0000-0000-000000000002", "X", 1000.0, 160.0, proporcionalidad=0.5, referencia_complemento_pago="bbbbbbbb-0000-0000-0000-000000000002")),
]
for nombre, factura in casos_efectivo:
    out[f"iva_efectivamente_pagado_{nombre}"] = {
        "entrada": {"iva": factura.iva, "proporcionalidad": factura.proporcionalidad, "referencia_complemento_pago": factura.referencia_complemento_pago},
        "resultado": factura.iva_acreditable_efectivamente_pagado,
    }

# --- conciliar_facturas_diot: match/mismatch/missing ---
facturas_conc = [
    f("cccccccc-0000-0000-0000-000000000001", "P1", 1000.0, 160.0),
    f("cccccccc-0000-0000-0000-000000000002", "P1", 1000.0, 160.0),
    f("cccccccc-0000-0000-0000-000000000003", "P1", 1000.0, 160.0),
]
diot_conc = [
    DIOTEntry(rfc_tercero="P1", monto_neto=1000.0, iva_trasladado=160.0, iva_acreditable=160.0, folios_fiscales=["cccccccc-0000-0000-0000-000000000001"]),
    DIOTEntry(rfc_tercero="P1", monto_neto=1000.0, iva_trasladado=160.0, iva_acreditable=100.0, folios_fiscales=["cccccccc-0000-0000-0000-000000000002"]),
]
res_conc = conciliar_facturas_diot(facturas_conc, diot_conc)
out["conciliar_facturas_diot"] = {
    "resultado": [{"factura_uuid": r.factura_uuid, "diot_match": r.diot_match, "status": r.status.value} for r in res_conc],
}

# --- conciliar_diot_declaracion: match (dentro de 5%) / mismatch (fuera de 5%) ---
diot_total_8000 = [DIOTEntry(rfc_tercero="P1", iva_acreditable=8000.0)]
declaraciones_match = [DeclaracionMensual(mes=1, año=2026, iva_pagado=8000.0)]
declaraciones_mismatch = [DeclaracionMensual(mes=1, año=2026, iva_pagado=5000.0)]
declaraciones_boundary_ok = [DeclaracionMensual(mes=1, año=2026, iva_pagado=8000.0 / 1.05)]  # exactamente 5% de diferencia
out["conciliar_diot_declaracion_match"] = {
    "resultado": [{"diot_iva_total": r.diot_iva_total, "declaracion_iva_acreditable": r.declaracion_iva_acreditable, "diferencia": r.diferencia, "status": r.status.value} for r in conciliar_diot_declaracion(diot_total_8000, declaraciones_match)],
}
out["conciliar_diot_declaracion_mismatch"] = {
    "resultado": [{"diot_iva_total": r.diot_iva_total, "declaracion_iva_acreditable": r.declaracion_iva_acreditable, "diferencia": r.diferencia, "status": r.status.value} for r in conciliar_diot_declaracion(diot_total_8000, declaraciones_mismatch)],
}
out["conciliar_diot_declaracion_ambos_cero"] = {
    "resultado": [{"status": r.status.value} for r in conciliar_diot_declaracion([], [DeclaracionMensual(mes=1, año=2026, iva_pagado=0.0)])],
}

# --- conciliar_declaracion_saldo: consistente / inconsistente ---
out["conciliar_declaracion_saldo_consistente"] = conciliar_declaracion_saldo([DeclaracionMensual(mes=1, año=2026, saldo_favor=3000.0)], 3000.0)
out["conciliar_declaracion_saldo_inconsistente"] = conciliar_declaracion_saldo([DeclaracionMensual(mes=1, año=2026, saldo_favor=3000.0)], 5000.0)

# --- calcular_saldo_favor / calcular_monto_devolucion ---
declaraciones_multi = [
    DeclaracionMensual(mes=1, año=2026, saldo_favor=3000.0),
    DeclaracionMensual(mes=2, año=2026, saldo_favor=2000.0),
    DeclaracionMensual(mes=3, año=2025, saldo_favor=500.0),
]
out["calcular_saldo_favor_multiple"] = calcular_saldo_favor(declaraciones_multi)
out["calcular_monto_devolucion"] = calcular_monto_devolucion(10000.0, [DeclaracionMensual(mes=1, año=2026, saldo_favor=10000.0)])
out["calcular_monto_devolucion_multi_periodo"] = calcular_monto_devolucion(5500.0, declaraciones_multi)

# --- validar_congruencia_diot_cfdi_declaracion ---
facturas_congruencia = [f("dddddddd-0000-0000-0000-000000000001", "P1", 1000.0, 160.0, fecha="2026-03-10")]
diot_congruencia = generar_diot(facturas_congruencia)
declaraciones_congruencia = [DeclaracionMensual(mes=3, año=2026, iva_pagado=160.0)]
out["congruencia_congruente"] = validar_congruencia_diot_cfdi_declaracion("2026-03", facturas_congruencia, diot_congruencia, declaraciones_congruencia)
out["congruencia_sin_diot"] = validar_congruencia_diot_cfdi_declaracion("2026-03", facturas_congruencia, [], declaraciones_congruencia)
declaraciones_incongruente = [DeclaracionMensual(mes=3, año=2026, iva_pagado=500.0)]
out["congruencia_incongruente"] = validar_congruencia_diot_cfdi_declaracion("2026-03", facturas_congruencia, diot_congruencia, declaraciones_incongruente)

# --- validate_clabe ---
out["clabe_valida"] = {"clabe": "014180655208094807", "error": validate_clabe("014180655208094807")}
out["clabe_digito_invalido"] = {"clabe": "014180655208094809", "error": validate_clabe("014180655208094809")}
out["clabe_longitud_invalida"] = {"clabe": "1234", "error": validate_clabe("1234")}
out["clabe_no_numerica"] = {"clabe": "01418065520809480X", "error": validate_clabe("01418065520809480X")}

# --- Art. 22 CFF: días hábiles ---
out["dias_habiles_desde_jueves"] = {
    "entrada": {"fecha_inicio": "2026-01-08", "dias": 40},  # jueves
    "resultado": sumar_dias_habiles("2026-01-08", 40).isoformat(),
}
out["fecha_limite_resolucion_sin_dictamen"] = {
    "entrada": {"fecha_presentacion": "2026-01-08", "hay_dictamen": False},
    "resultado": calcular_fecha_limite_resolucion("2026-01-08", False).isoformat(),
}
out["fecha_limite_resolucion_con_dictamen"] = {
    "entrada": {"fecha_presentacion": "2026-01-08", "hay_dictamen": True},
    "resultado": calcular_fecha_limite_resolucion("2026-01-08", True).isoformat(),
}
# Cruza un feriado (2026-05-01, Día del Trabajo) y un fin de semana.
out["dias_habiles_cruza_feriado"] = {
    "entrada": {"fecha_inicio": "2026-04-27", "dias": 5},
    "resultado": sumar_dias_habiles("2026-04-27", 5).isoformat(),
}

print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
