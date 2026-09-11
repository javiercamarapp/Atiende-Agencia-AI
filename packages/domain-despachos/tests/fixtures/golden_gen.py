# Generador del golden-set numérico de validate_cfdi (Python real) — Fase 1 despachos
# §8. Ejecutado UNA VEZ contra el intérprete real del repo `despachos` (venv con lxml
# instalado en despachos/.venv) para producir golden-python-output.json, que queda
# congelado y versionado junto a este script. Correrlo de nuevo (requiere el checkout
# de despachos en la ruta de abajo + su venv) debe reproducir EXACTAMENTE el mismo
# JSON — si no lo hace, el Python original cambió, no el golden.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 golden_gen.py
#
# Los 15 casos son dicts construidos a mano (no XML parseado) para poder aislar cada
# regla avanzada con precisión (retenciones exactas/con desviación, timbrado a horas
# exactas, notas de crédito con TipoRelacion variando) — ver
# tests/reglas-fiscales-avanzadas.golden.spec.ts para el lado TypeScript de la
# comparación campo por campo.
import sys, json
sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")
from decimal import Decimal
from b2b_ai.cfdi.validator import validate_cfdi

def ser(o):
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, dict):
        return {k: ser(v) for k, v in o.items()}
    if isinstance(o, list):
        return [ser(v) for v in o]
    return o

def base_datos(**overrides):
    d = {
        "tipo": "I",
        "subtotal": "1000.00",
        "total": "1160.00",
        "descuento": "0",
        "iva": "160.00",
        "total_impuestos_trasladados": "160.00",
        "conceptos": [{"cantidad": "1", "valor_unitario": "1000.00", "importe": "1000.00", "traslados": []}],
        "uso_cfdi": "G03",
        "forma_pago": "03",
        "metodo_pago": "PUE",
        "emisor": {"regimen_fiscal": "601"},
        "emisor_rfc": "CON950820K12",
        "emisor_nombre": "PROVEEDOR DE PRUEBA SA DE CV",
        "receptor_rfc": "XAXX010101000",
        "tiene_sello": True,
        "no_certificado": "00001000000504465028",
        "folio_fiscal": "11111111-2222-3333-4444-555555555555",
        "fecha": "2026-07-01T10:00:00",
        "fecha_timbrado": "2026-07-01T10:05:00",
    }
    d.update(overrides)
    return d

cases = {}

# CASO 1: base valida, ingreso, DIOT reportable
cases["01_base_ingreso_diot"] = base_datos()

# CASO 2: retencion ISR exacta 10% -> sin warning
cases["02_retencion_isr_exacta_10pct"] = base_datos(
    subtotal="1000.00", total="890.00", iva="0", total_impuestos_trasladados=None,
    retenciones_isr="100.00",
)

# CASO 3: retencion ISR con desviacion de $0.01 (dentro de tolerancia $1.00) -> sin warning
cases["03_retencion_isr_desviacion_0_01"] = base_datos(
    subtotal="1000.00", total="899.99", iva="0", total_impuestos_trasladados=None,
    retenciones_isr="100.01",
)

# CASO 4: retencion ISR con desviacion de $1.01 (fuera de tolerancia) -> warning
cases["04_retencion_isr_desviacion_1_01_fuera_tolerancia"] = base_datos(
    subtotal="1000.00", total="898.99", iva="0", total_impuestos_trasladados=None,
    retenciones_isr="101.01",
)

# CASO 5: retencion IVA exacta 2/3 del IVA -> sin warning
cases["05_retencion_iva_exacta_2_3"] = base_datos(
    subtotal="1000.00", total="1053.35", iva="160.00", retenciones_iva="106.65",
)

# CASO 6: timbrado a 71h59m (dentro de 72h) -> sin warning de fecha
cases["06_timbrado_71h59m"] = base_datos(
    fecha="2026-07-01T00:00:00", fecha_timbrado="2026-07-03T23:59:00",
)

# CASO 7: timbrado a 72h01m -> el truncamiento a dias enteros de Python NO dispara warning
# (diff.days == 3, no > 3) pese a exceder 72h nominales -- comportamiento real verificado.
cases["07_timbrado_72h01m_no_dispara_por_truncamiento_dias"] = base_datos(
    fecha="2026-07-01T00:00:00", fecha_timbrado="2026-07-04T00:01:00",
)

# CASO 8: timbrado a 96h01m (>=4 dias completos) -> SI dispara warning
cases["08_timbrado_96h01m_dispara_warning"] = base_datos(
    fecha="2026-07-01T00:00:00", fecha_timbrado="2026-07-05T00:01:00",
)

# CASO 9: IEPS presente -> warning de declaracion separada
cases["09_ieps_presente"] = base_datos(ieps="50.00")

# CASO 10: nomina con metodo_pago distinto de PUE -> fail
cases["10_nomina_metodo_pago_no_pue"] = base_datos(
    metodo_pago="PPD", nomina={"total_percepciones": "5000.00"},
)

# CASO 11: nomina sin TotalPercepciones -> warning
cases["11_nomina_sin_total_percepciones"] = base_datos(
    nomina={},
)

# CASO 12: nota de credito (tipo E) SIN CfdiRelacionados -> fail
cases["12_nota_credito_sin_relacionados"] = base_datos(
    tipo="E", subtotal="500.00", total="0", iva="80.00", descuento="580.00",
    total_impuestos_trasladados="80.00",
    conceptos=[{"cantidad": "1", "valor_unitario": "500.00", "importe": "500.00", "traslados": []}],
)

# CASO 13: nota de credito con TipoRelacion="01" y relacionados -> ok
cases["13_nota_credito_tiporelacion_01"] = base_datos(
    tipo="E", subtotal="500.00", total="0", iva="80.00", descuento="580.00",
    total_impuestos_trasladados="80.00",
    conceptos=[{"cantidad": "1", "valor_unitario": "500.00", "importe": "500.00", "traslados": []}],
    cfdi_relacionados=["11111111-2222-3333-4444-555555555556"],
    tipo_relacion="01",
)

# CASO 14: nota de credito con TipoRelacion="04" (otro codigo) y relacionados -> warning
cases["14_nota_credito_tiporelacion_04_otro_codigo"] = base_datos(
    tipo="E", subtotal="500.00", total="0", iva="80.00", descuento="580.00",
    total_impuestos_trasladados="80.00",
    conceptos=[{"cantidad": "1", "valor_unitario": "500.00", "importe": "500.00", "traslados": []}],
    cfdi_relacionados=["11111111-2222-3333-4444-555555555556"],
    tipo_relacion="04",
)

# CASO 15: nota de credito con relacionados pero SIN tipo_relacion -> fail tipo_relacion_faltante
cases["15_nota_credito_sin_tiporelacion"] = base_datos(
    tipo="E", subtotal="500.00", total="0", iva="80.00", descuento="580.00",
    total_impuestos_trasladados="80.00",
    conceptos=[{"cantidad": "1", "valor_unitario": "500.00", "importe": "500.00", "traslados": []}],
    cfdi_relacionados=["11111111-2222-3333-4444-555555555556"],
    tipo_relacion="",
)

out = {}
for name, datos in cases.items():
    try:
        res = validate_cfdi(datos)
        out[name] = ser(res)
    except Exception as e:
        out[name] = {"__error__": repr(e)}

print(json.dumps(out, indent=2, ensure_ascii=False))
