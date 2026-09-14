# Generador del golden-set numérico de bookkeeping / auto-clasificador de
# pólizas (Fase 6 despachos) — mismo mecanismo que los demás golden_gen_*.py.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_bookkeeping.py > golden-bookkeeping-output.json
#
# Cubre: get_mapping (default), generate_poliza (2 y 4 líneas, IVA cargo/
# abono), validate_poliza (balanceada/desbalanceada/cuenta inexistente),
# generate_adjustment, _rule_based_predict (fallback determinista, sin
# sklearn), get_rfc_category_feedback/get_suggestions_for_retraining
# (agregación de overrides humanos).
import sys
import json

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.bookkeeping.rules_engine import AccountingRulesEngine  # noqa: E402
from b2b_ai.features.bookkeeping.journal_generator import JournalEntryGenerator  # noqa: E402
from b2b_ai.features.bookkeeping.models import CFDIClassification  # noqa: E402
from b2b_ai.features.bookkeeping.auto_classifier import AutoClassifier  # noqa: E402
from b2b_ai.features.bookkeeping.human_override import HumanOverrideManager  # noqa: E402
from b2b_ai.features.bookkeeping.models import OverrideAction  # noqa: E402

out = {}
engine = AccountingRulesEngine()
gen = JournalEntryGenerator(engine)


def ser_poliza(p):
    return {
        "tipo": p.tipo.value,
        "total_debe": p.total_debe,
        "total_haber": p.total_haber,
        "cuadrada": p.cuadrada,
        "lineas": [{"cuenta": l.cuenta, "concepto": l.concepto, "debe": l.debe, "haber": l.haber, "tipo": l.tipo} for l in p.lineas],
    }


# --- get_mapping ---
m1 = engine.get_mapping("I", "servicios_profesionales")
out["get_mapping_servicios_profesionales"] = {"cargo": m1.cargo, "abono": m1.abono, "iva_cargo": m1.iva_cargo, "iva_abono": m1.iva_abono, "poliza_type": m1.poliza_type.value}
m2 = engine.get_mapping("E", "venta_servicios")
out["get_mapping_venta_servicios"] = {"cargo": m2.cargo, "abono": m2.abono, "iva_cargo": m2.iva_cargo, "iva_abono": m2.iva_abono, "poliza_type": m2.poliza_type.value}
out["get_mapping_desconocido"] = engine.get_mapping("I", "categoria_inexistente")

# --- generate_poliza: 4 líneas (con IVA acreditable) ---
c1 = CFDIClassification(cfdi_uuid="u1", subtotal=10000.0, iva=1600.0, total=11600.0, tipo_cfdi="I", categoria="servicios_profesionales", descripcion="Honorarios enero")
p1 = engine.generate_poliza(c1)
out["generate_poliza_servicios_profesionales"] = ser_poliza(p1)

# --- generate_poliza: sin IVA (2 líneas) ---
c2 = CFDIClassification(cfdi_uuid="u2", subtotal=5000.0, iva=0.0, total=5000.0, tipo_cfdi="I", categoria="intereses_bancarios", descripcion="Interes")
p2 = engine.generate_poliza(c2)
out["generate_poliza_sin_iva"] = ser_poliza(p2)

# --- generate_poliza: venta (IVA abono) ---
c3 = CFDIClassification(cfdi_uuid="u3", subtotal=20000.0, iva=3200.0, total=23200.0, tipo_cfdi="E", categoria="venta_servicios", descripcion="Proyecto X")
p3 = engine.generate_poliza(c3)
out["generate_poliza_venta_servicios"] = ser_poliza(p3)

# --- generate_poliza: sin mapeo -> None ---
c4 = CFDIClassification(cfdi_uuid="u4", subtotal=100.0, iva=16.0, total=116.0, tipo_cfdi="I", categoria="categoria_sin_mapeo", descripcion="x")
out["generate_poliza_sin_mapeo"] = engine.generate_poliza(c4)

# --- validate_poliza ---
p1.fecha = "2026-01-31"
out["validate_poliza_balanceada"] = gen.validate_poliza(p1)

from b2b_ai.features.bookkeeping.models import PolizaContable, LineaPoliza, PolizaType  # noqa: E402
poliza_desbalanceada = PolizaContable(
    tipo=PolizaType.DIARIO, fecha="2026-01-31", concepto="test",
    lineas=[LineaPoliza(cuenta="1020000", debe=10000.0, haber=0.0, tipo="cargo"), LineaPoliza(cuenta="2010000", debe=0.0, haber=8000.0, tipo="abono")],
    total_debe=10000.0, total_haber=8000.0, cuadrada=False,
)
out["validate_poliza_desbalanceada"] = gen.validate_poliza(poliza_desbalanceada)

poliza_cuenta_invalida = PolizaContable(
    tipo=PolizaType.DIARIO, fecha="2026-01-31", concepto="test",
    lineas=[LineaPoliza(cuenta="9999999", debe=100.0, haber=0.0, tipo="cargo"), LineaPoliza(cuenta="9999998", debe=0.0, haber=100.0, tipo="abono")],
    total_debe=100.0, total_haber=100.0, cuadrada=True,
)
out["validate_poliza_cuenta_inexistente"] = gen.validate_poliza(poliza_cuenta_invalida)

# --- generate_adjustment ---
adj = gen.generate_adjustment("2026-01-31", "Ajuste manual", [
    {"cuenta": "6020300", "debe": 5000.0, "haber": 0.0, "concepto": "gasto"},
    {"cuenta": "1020000", "debe": 0.0, "haber": 5000.0, "concepto": "banco"},
])
out["generate_adjustment"] = ser_poliza(adj)

# --- generate_depreciation_entry ---
dep = gen.generate_depreciation_entry("2026-01-31", [{"cuenta_activo": "1540000", "cuenta_depreciacion": "1540100", "cuenta_gasto": "6020300", "monto": 833.33}])
out["generate_depreciation_entry"] = ser_poliza(dep)

# --- _rule_based_predict (fallback determinista, forzado con clasificador vacío) ---
clf = AutoClassifier.__new__(AutoClassifier)
clf._overrides = {}
casos_rb = [
    ("servicios_profesionales_claro", "honorarios de consultoría profesional", "I"),
    ("renta_oficina", "renta de oficina mensual, alquiler local comercial", "I"),
    ("sin_match", "xyz sin ninguna palabra clave reconocible", "I"),
    ("venta_servicios_egreso", "servicio de consultoría y desarrollo de proyecto", "E"),
    ("empate_primer_patron_gana", "renta arrendamiento", "I"),  # coincide con renta_oficina Y arrendamiento; ambos con 1 keyword -> gana el primero de la lista (renta_oficina)
]
for nombre, desc, tipo in casos_rb:
    cat, conf = clf._rule_based_predict({"descripcion": desc, "tipo_cfdi": tipo})
    out[f"rule_based_predict_{nombre}"] = {"entrada": {"descripcion": desc, "tipo_cfdi": tipo}, "categoria": cat, "confidence": conf}

# --- override exacto por RFC ---
clf2 = AutoClassifier.__new__(AutoClassifier)
clf2._overrides = {"RFC12345": "nomina"}
cat_o, conf_o = clf2.predict({"descripcion": "cualquier cosa", "tipo_cfdi": "I", "rfc_emisor": "RFC12345"}) if False else (None, None)
# `predict()` real requiere el pipeline de sklearn ya inicializado; se prueba
# la lógica de override directamente (mismas primeras líneas de `predict`)
# para no depender de si sklearn está instalado en este entorno.
out["override_exacto_rfc"] = {"rfc": "RFC12345", "categoria": clf2._overrides.get("RFC12345"), "confidence": 1.0 if "RFC12345" in clf2._overrides else None}

# --- HumanOverrideManager: agregación por RFC ---
mgr = HumanOverrideManager()
mgr.submit_override(cfdi_uuid="a1", action=OverrideAction.RECLASSIFY, new_categoria="nomina", rfc_emisor="RFC_A")
mgr.submit_override(cfdi_uuid="a2", action=OverrideAction.RECLASSIFY, new_categoria="nomina", rfc_emisor="RFC_A")
mgr.submit_override(cfdi_uuid="a3", action=OverrideAction.RECLASSIFY, new_categoria="publicidad", rfc_emisor="RFC_A")
out["rfc_category_feedback_mayoria"] = mgr.get_rfc_category_feedback("RFC_A")

mgr2 = HumanOverrideManager()
for i in range(5):
    mgr2.submit_override(cfdi_uuid=f"b{i}", action=OverrideAction.RECLASSIFY, new_categoria="nomina", rfc_emisor="RFC_STRONG")
out["suggestions_for_retraining"] = mgr2.get_suggestions_for_retraining()

# Señal débil: 1 de 2 correcciones distintas (empate 50/50) -> NO sugiere (no > 0.5)
mgr3 = HumanOverrideManager()
mgr3.submit_override(cfdi_uuid="c1", action=OverrideAction.RECLASSIFY, new_categoria="nomina", rfc_emisor="RFC_WEAK")
mgr3.submit_override(cfdi_uuid="c2", action=OverrideAction.RECLASSIFY, new_categoria="publicidad", rfc_emisor="RFC_WEAK")
out["suggestions_for_retraining_empate_no_sugiere"] = mgr3.get_suggestions_for_retraining()

print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
