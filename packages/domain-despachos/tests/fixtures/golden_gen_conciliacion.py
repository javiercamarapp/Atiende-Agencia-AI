# Generador del golden-set de conciliación bancaria (Fase 5 despachos) — corre el
# `MatchingEngine` REAL (b2b_ai/features/reconciliation_agent/matching_engine.py)
# contra escenarios de niveles 1 (exacto) y 3 (multi-línea), que NO dependen de
# `rapidfuzz.fuzz.partial_ratio` y por lo tanto SÍ deben comparar byte-exacto en
# TS (`matching-engine.golden.spec.ts`). Los casos de nivel 2 (fuzzy) se generan
# aparte y se comparan con tolerancia documentada — ver ese mismo archivo — porque
# `partialRatio` es una aproximación (ver text-similarity.ts, comentario de
# cabecera), no un puerto byte-exacto de la búsqueda interna de rapidfuzz.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_conciliacion.py > golden-conciliacion-output.json
import sys
import json

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.reconciliation_agent.matching_engine import MatchingEngine  # noqa: E402
from b2b_ai.features.reconciliation_agent.models import BankMovement  # noqa: E402


def mov(fecha, descripcion="", referencia=None, monto=0.0, banco="generic", formato="csv"):
    cargo = abs(monto) if monto < 0 else None
    abono = monto if monto >= 0 else None
    return BankMovement(fecha=fecha, descripcion=descripcion, referencia=referencia, cargo=cargo, abono=abono, saldo=None, monto=monto, banco=banco, formato=formato)


def ser_result(r):
    return {
        "matched": [
            {
                "movementIdx": m.movement_idx,
                "registroIdx": m.registro_idx,
                "registroIndices": m.registro_indices,
                "level": m.level.value,
                "score": m.score,
                "montoBanco": m.monto_banco,
                "montoRegistro": m.monto_registro,
                "fechaBanco": m.fecha_banco,
                "fechaRegistro": m.fecha_registro,
            }
            for m in r.matched
        ],
        "unmatchedBankCount": len(r.unmatched_bank),
        "unmatchedBooksCount": len(r.unmatched_books),
        "confidence": r.confidence,
        "totalMovements": r.total_movements,
        "totalRecords": r.total_records,
        "totalMatched": r.total_matched,
        "matchRate": r.match_rate,
        "montoMatched": r.monto_matched,
        "montoUnmatchedBank": r.monto_unmatched_bank,
        "montoUnmatchedBooks": r.monto_unmatched_books,
    }


out = {}

# =====================================================================
# NIVEL 1 — exacto (byte-exacto, sin dependencia de rapidfuzz)
# =====================================================================
engine_default = MatchingEngine()

# Caso 1: mismo monto, misma fecha, sin referencia -> exacto score=100
movs1 = [mov("2025-03-10", "Deposito cliente", None, 1500.0)]
recs1 = [{"id": "r1", "fecha": "2025-03-10", "monto": 1500.0, "descripcion": "Factura cliente ABC"}]
out["nivel1_misma_fecha_sin_referencia"] = {"entrada": {"movimientos": [m.model_dump() for m in movs1], "registros": recs1}, "resultado": ser_result(engine_default.match(movs1, recs1))}

# Caso 2: mismo monto, 1 dia de diferencia, sin referencia -> exacto score=97 (diff==0 no, pero ref_match false y diff==1 no cumple "ref_match or diff==0" -> NO matchea)
movs2 = [mov("2025-03-11", "Deposito cliente", None, 1500.0)]
recs2 = [{"id": "r1", "fecha": "2025-03-10", "monto": 1500.0, "descripcion": "Factura cliente ABC"}]
out["nivel1_un_dia_diferencia_sin_referencia_no_matchea"] = {"entrada": {"movimientos": [m.model_dump() for m in movs2], "registros": recs2}, "resultado": ser_result(engine_default.match(movs2, recs2))}

# Caso 3: mismo monto, 1 dia de diferencia, CON referencia coincidente -> exacto score=97
movs3 = [mov("2025-03-11", "Pago SPEI", "FACT-9988", 2300.50)]
recs3 = [{"id": "r1", "fecha": "2025-03-10", "monto": 2300.50, "descripcion": "Factura", "referencia": "FACT-9988"}]
out["nivel1_un_dia_diferencia_con_referencia"] = {"entrada": {"movimientos": [m.model_dump() for m in movs3], "registros": recs3}, "resultado": ser_result(engine_default.match(movs3, recs3))}

# Caso 4: monto fuera de tolerancia 0.01 -> no matchea en absoluto (nivel1/2/3 fallan)
movs4 = [mov("2025-03-10", "Deposito", None, 1000.02)]
recs4 = [{"id": "r1", "fecha": "2025-03-10", "monto": 1000.00, "descripcion": "Factura"}]
out["nivel1_fuera_de_tolerancia_0_01"] = {"entrada": {"movimientos": [m.model_dump() for m in movs4], "registros": recs4}, "resultado": ser_result(engine_default.match(movs4, recs4))}

# Caso 5: 2 movimientos, 2 registros, ambos exactos
movs5 = [mov("2025-01-05", "Pago A", None, 500.0), mov("2025-01-06", "Pago B", None, 750.0)]
recs5 = [{"id": "r1", "fecha": "2025-01-05", "monto": 500.0}, {"id": "r2", "fecha": "2025-01-06", "monto": 750.0}]
out["nivel1_multiples_exactos"] = {"entrada": {"movimientos": [m.model_dump() for m in movs5], "registros": recs5}, "resultado": ser_result(engine_default.match(movs5, recs5))}

# =====================================================================
# NIVEL 3 — multi-línea (subset sum, byte-exacto)
# =====================================================================

# Caso 6: un pago de 5000 cubre 3 facturas (2000+1500+1500)
movs6 = [mov("2025-02-01", "Transferencia SPEI", None, 5000.0)]
recs6 = [
    {"id": "r1", "fecha": "2025-02-01", "monto": 2000.0},
    {"id": "r2", "fecha": "2025-02-02", "monto": 1500.0},
    {"id": "r3", "fecha": "2025-02-01", "monto": 1500.0},
]
out["nivel3_multilinea_3_facturas_exacto"] = {"entrada": {"movimientos": [m.model_dump() for m in movs6], "registros": recs6}, "resultado": ser_result(engine_default.match(movs6, recs6))}

# Caso 7: multi-linea con tolerancia de 1% (suma no exacta pero dentro de tolerancia)
movs7 = [mov("2025-02-10", "Transferencia SPEI", None, 3000.0)]
recs7 = [
    {"id": "r1", "fecha": "2025-02-10", "monto": 1000.0},
    {"id": "r2", "fecha": "2025-02-10", "monto": 1995.0},  # suma=2995, diff=5, tol=1%=30 -> dentro
]
out["nivel3_multilinea_dentro_tolerancia_1pct"] = {"entrada": {"movimientos": [m.model_dump() for m in movs7], "registros": recs7}, "resultado": ser_result(engine_default.match(movs7, recs7))}

# Caso 8: monto < 100 -> nunca intenta multi-linea
movs8 = [mov("2025-02-15", "Pago chico", None, 50.0)]
recs8 = [{"id": "r1", "fecha": "2025-02-15", "monto": 20.0}, {"id": "r2", "fecha": "2025-02-15", "monto": 30.0}]
out["nivel3_monto_menor_100_no_intenta"] = {"entrada": {"movimientos": [m.model_dump() for m in movs8], "registros": recs8}, "resultado": ser_result(engine_default.match(movs8, recs8))}

# Caso 9: solo 1 candidato dentro de tolerancia de fecha -> no intenta (requiere >=2)
movs9 = [mov("2025-02-20", "Pago", None, 500.0)]
recs9 = [{"id": "r1", "fecha": "2025-02-20", "monto": 200.0}]
out["nivel3_un_solo_candidato_no_intenta"] = {"entrada": {"movimientos": [m.model_dump() for m in movs9], "registros": recs9}, "resultado": ser_result(engine_default.match(movs9, recs9))}

# Caso 10: combinación de niveles 1+3 en un solo lote
movs10 = [mov("2025-03-01", "Pago exacto", None, 900.0), mov("2025-03-02", "Transferencia multi", None, 4000.0)]
recs10 = [
    {"id": "r1", "fecha": "2025-03-01", "monto": 900.0},
    {"id": "r2", "fecha": "2025-03-02", "monto": 2500.0},
    {"id": "r3", "fecha": "2025-03-02", "monto": 1500.0},
]
out["combinado_nivel1_y_nivel3"] = {"entrada": {"movimientos": [m.model_dump() for m in movs10], "registros": recs10}, "resultado": ser_result(engine_default.match(movs10, recs10))}

# =====================================================================
# NIVEL 2 — fuzzy (con tolerancia documentada en TS, se genera igual para cruzar
# nivel/decisión aunque el score fino pueda variar unos puntos)
# =====================================================================
movs11 = [mov("2025-04-01", "Pago factura Juan Perez Servicios", "REF001", 1030.0)]
recs11 = [{"id": "r1", "fecha": "2025-04-02", "monto": 1000.0, "descripcion": "Factura Juan Perez Servicios Profesionales"}]
out["nivel2_fuzzy_descripcion_similar_monto_cercano"] = {"entrada": {"movimientos": [m.model_dump() for m in movs11], "registros": recs11}, "resultado": ser_result(engine_default.match(movs11, recs11))}

print(json.dumps(out, indent=2, ensure_ascii=False))
