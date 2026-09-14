# Generador del golden-set numérico de validaciones de cierre mensual (Fase 6
# despachos) — puerto de `b2b_ai/features/close_management/validation_engine.py::
# ValidationEngine`. Mismo mecanismo que los demás golden_gen_*.py.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_cierre_mensual.py > golden-cierre-mensual-output.json
import sys
import json

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.close_management.validation_engine import ValidationEngine  # noqa: E402

out = {}
engine = ValidationEngine()


def ser(r):
    return {"type": r.type.value, "passed": r.passed, "message": r.message, "details": r.details}


out["balance_cuadrada_ok"] = ser(engine.validate_balance_cuadrada(100000.0, 100000.50))
out["balance_cuadrada_fail"] = ser(engine.validate_balance_cuadrada(1000.0, 1500.0))
out["balance_cuadrada_limite_exacto"] = ser(engine.validate_balance_cuadrada(1000.0, 1001.0))  # diff == tolerancia (1.0) -> pasa

out["polizas_cuadradas_ok"] = ser(engine.validate_polizas_cuadradas([{"id": "p1", "total_debe": 100.0, "total_haber": 100.0}, {"id": "p2", "total_debe": 50.0, "total_haber": 50.005}]))
out["polizas_cuadradas_fail"] = ser(engine.validate_polizas_cuadradas([{"id": "p1", "total_debe": 100.0, "total_haber": 90.0}]))

out["nomina_cuadrada_ok"] = ser(engine.validate_nomina_cuadrada([{"sueldo_bruto": 10000.0, "total_deducciones": 2000.0, "sueldo_neto": 8000.0}]))
out["nomina_cuadrada_fail"] = ser(engine.validate_nomina_cuadrada([{"sueldo_bruto": 10000.0, "total_deducciones": 2000.0, "sueldo_neto": 7000.0}]))

out["iva_conciliado_ok"] = ser(engine.validate_iva_conciliado(50000.0, 30000.0, 20000.0))
out["iva_conciliado_fail"] = ser(engine.validate_iva_conciliado(50000.0, 30000.0, 15000.0))

out["isr_sin_utilidad"] = ser(engine.validate_isr_provisionado(0.0, -5000.0))
out["isr_ok"] = ser(engine.validate_isr_provisionado(30000.0, 100000.0))
out["isr_fail"] = ser(engine.validate_isr_provisionado(10000.0, 100000.0))

out["bancos_ok_fraccion"] = ser(engine.validate_bancos_conciliados(0.95, 100, 95))
out["bancos_fail_fraccion"] = ser(engine.validate_bancos_conciliados(0.5, 100, 50))

print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
