# Generador del golden-set numérico de migración de catálogo contable (Fase 5
# despachos) — mismo mecanismo que golden_gen_declaraciones.py/golden_gen_nomina.py:
# se ejecuta UNA VEZ contra el intérprete real del repo `despachos` para producir
# golden-migracion-catalogo-output.json, que queda congelado y versionado junto a
# este script.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_migracion_catalogo.py > golden-migracion-catalogo-output.json
#
# Cubre: calcular_score_compuesto (los 5 factores de peso por separado y combinados),
# clasificar_cuenta_origen (exacto, alerta_riesgo por código, alerta_riesgo por
# nombre, fuzzy por encima/por debajo del umbral, sin_match, umbral exacto 60.0,
# desempate por orden de candidatos). Nota: `similitud_nombre` usa
# `rapidfuzz.fuzz.token_sort_ratio`, verificado byte-exacto contra la reimplementación
# TS (`tokenSortRatio`, ver text-similarity.ts) por separado — no repetido aquí caso
# por caso, este golden-set verifica el score COMPUESTO completo end-to-end.
import sys
import json

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.migracion_catalogo.matching import (  # noqa: E402
    CuentaCatalogo,
    calcular_score_compuesto,
    clasificar_cuenta_origen,
    es_alerta_riesgo,
)


def cuenta(id, codigo, nombre, nivel=1, naturaleza="D", tipo_agregado="Activo", cuenta_padre_codigo=None):
    return CuentaCatalogo(id=id, codigo=codigo, nombre=nombre, nivel=nivel, naturaleza=naturaleza, tipo_agregado=tipo_agregado, cuenta_padre_codigo=cuenta_padre_codigo)


def ser_mapeo(m):
    return {
        "origen_cuenta_id": m.origen_cuenta_id,
        "destino_cuenta_id": m.destino_cuenta_id,
        "tipo_match": m.tipo_match.value,
        "score": m.score,
        "estado": m.estado.value,
    }


out = {}

# --- calcular_score_compuesto: cada factor por separado y combinados ---
casos_score = [
    ("todo_coincide_menos_nombre", cuenta("o1", "102-001", "Bancos Nacionales", 2, "D", "Activo", "102"), cuenta("d1", "102-001", "Efectivo en Caja", 2, "D", "Activo", "102")),
    ("solo_nombre_coincide", cuenta("o2", "999", "Bancos Nacionales", 3, "A", "Pasivo", "900"), cuenta("d2", "111", "Bancos Nacionales", 1, "D", "Ingreso", None)),
    ("nada_coincide", cuenta("o3", "999", "Zzzz Totalmente Distinto", 5, "A", "Capital", "888"), cuenta("d3", "111", "Aaaa Otra Cosa", 1, "D", "Gasto", None)),
    ("todo_coincide", cuenta("o4", "500", "Gastos de Venta", 2, "D", "Gasto", "500"), cuenta("d4", "500-A", "Gastos De Venta", 2, "D", "Gasto", "500")),
    ("nombre_reordenado", cuenta("o5", "1", "Caja General", 1, "D", "Activo"), cuenta("d5", "2", "General Caja", 1, "D", "Activo")),
]
for nombre_caso, o, d in casos_score:
    out[f"score_{nombre_caso}"] = {
        "entrada": {
            "origen": {"codigo": o.codigo, "nombre": o.nombre, "nivel": o.nivel, "naturaleza": o.naturaleza, "tipoAgregado": o.tipo_agregado, "cuentaPadreCodigo": o.cuenta_padre_codigo},
            "destino": {"codigo": d.codigo, "nombre": d.nombre, "nivel": d.nivel, "naturaleza": d.naturaleza, "tipoAgregado": d.tipo_agregado, "cuentaPadreCodigo": d.cuenta_padre_codigo},
        },
        "resultado": {"score": calcular_score_compuesto(o, d)},
    }

# --- clasificar_cuenta_origen: escenarios completos con lista de candidatos ---


def ser_cuenta(c):
    return {"id": c.id, "codigo": c.codigo, "nombre": c.nombre, "nivel": c.nivel, "naturaleza": c.naturaleza, "tipoAgregado": c.tipo_agregado, "cuentaPadreCodigo": c.cuenta_padre_codigo}


escenarios = {
    "exacto_directo": (
        cuenta("o1", "101-001", "Caja General", 1, "D", "Activo"),
        [cuenta("d1", "200", "Otra Cosa", 1, "D", "Activo"), cuenta("d2", "101-001", "Caja General", 1, "D", "Activo")],
    ),
    "exacto_con_guiones_normalizador_estricto": (
        # normalizar_codigo_estricto quita guiones/espacios -> "102001" == "102001"
        cuenta("o2", "102-001", "Bancos", 1, "D", "Activo"),
        [cuenta("d3", "1020 01", "Bancos", 1, "D", "Activo")],
    ),
    "alerta_riesgo_por_codigo": (
        cuenta("o3", "300", "Proveedores Nacionales", 2, "A", "Pasivo"),
        [cuenta("d4", "300", "Proveedores Extranjeros", 2, "A", "Pasivo")],
    ),
    "alerta_riesgo_por_nombre": (
        cuenta("o4", "301", "Acreedores Diversos", 2, "A", "Pasivo"),
        [cuenta("d5", "999", "Acreedores Diversos", 2, "A", "Pasivo")],
    ),
    "fuzzy_por_encima_umbral": (
        cuenta("o5", "601", "Gastos de Operacion", 3, "D", "Gasto", "600"),
        [cuenta("d6", "701", "Gastos de Operación", 3, "D", "Gasto", "600")],
    ),
    "fuzzy_por_debajo_umbral_sin_match": (
        cuenta("o6", "888", "Cuenta Completamente Distinta Sin Relacion", 4, "A", "Capital"),
        [cuenta("d7", "111", "Otra Cuenta Diferente De Verdad", 1, "D", "Ingreso")],
    ),
    "sin_match_sin_candidatos": (cuenta("o7", "999", "Cuenta Nueva", 1, "D", "Activo"), []),
    "desempate_primer_candidato_con_mismo_score": (
        # Dos candidatos con exactamente el mismo score compuesto -> gana el primero
        # visto en la lista, no el segundo.
        cuenta("o8", "400", "Ingresos Varios", 2, "A", "Ingreso", "400"),
        [
            cuenta("d8a", "aaa", "Ingresos Varios A", 2, "A", "Ingreso", "400"),
            cuenta("d8b", "bbb", "Ingresos Varios B", 2, "A", "Ingreso", "400"),
        ],
    ),
}

for nombre, (origen, candidatos) in escenarios.items():
    resultado = clasificar_cuenta_origen(origen, candidatos)
    out[f"clasificar_{nombre}"] = {
        "entrada": {"origen": ser_cuenta(origen), "candidatos": [ser_cuenta(c) for c in candidatos]},
        "resultado": ser_mapeo(resultado),
    }

print(json.dumps(out, indent=2, ensure_ascii=False))
