# Generador del golden-set numérico de ISR/DIOT (Fase 2 despachos) — mismo mecanismo
# que tests/fixtures/golden_gen.py de Fase 1: se ejecuta UNA VEZ contra el intérprete
# real del repo `despachos` (venv con las dependencias instaladas en despachos/.venv)
# para producir golden-declaraciones-output.json, que queda congelado y versionado
# junto a este script. Correrlo de nuevo (requiere el checkout de despachos en la ruta
# de abajo + su venv) debe reproducir EXACTAMENTE el mismo JSON — si no lo hace, el
# Python original cambió, no el golden.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_declaraciones.py > golden-declaraciones-output.json
#
# Fuente de verdad usada (ver diseño Fase 2 §1): las tablas que `engine.py` REALMENTE
# ejecuta hoy son ISR_MENSUAL_2025/ISR_ANUAL_2025 (import fijo, no por año fiscal) y
# ISR_PM_MENSUAL_RESICO (definida en el propio engine.py). Fidelidad estricta al
# comportamiento actual — no se sustituye por get_isr_table(FISCAL_YEAR).
#
# Cada caso se guarda como {"entrada": ..., "resultado": ...} para que el lado
# TypeScript (tests/declaraciones.golden.spec.ts) no tenga que re-derivar el input a
# mano desde el output — evita una segunda oportunidad de transcripción manual.
#
# Los casos de límite de tramo (lower/upper/valor_alto) se generan PROGRAMÁTICAMENTE a
# partir de la tabla real importada, no transcritos a mano — así el propio script no
# puede tener un error de transcripción distinto al de fiscal_tables.py: el límite
# superior de cada tramo se deriva como (límite_inferior del tramo siguiente − 0.01),
# igual que la regla real de clasificación de _apply_isr_table (diseño §2.1).
import sys
import json
from dataclasses import asdict

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.features.declaraciones.engine import (  # noqa: E402
    ISR_TABLE_MONTHLY,
    ISR_TABLE_ANNUAL,
    ISR_PM_MENSUAL_RESICO,
    calculate_isr_pf,
    calculate_isr_pm,
    calculate_isr_pm_resico,
    aggregate_diot,
)


def ser(o):
    return asdict(o)


out = {}

# ===================================================================
# ISR PF — mensual y anual, e ISR PM RESICO (casos de límite de tramo, generados
# programáticamente desde la tabla real)
# ===================================================================

def boundary_cases(table, calc_fn, prefix):
    cases = {}
    n = len(table)
    for i, row in enumerate(table):
        lower = row[0]
        cases[f"{prefix}_tramo{i}_lower"] = (lower, calc_fn(lower))
        if i < n - 1:
            next_lower = table[i + 1][0]
            upper_boundary = round(next_lower - 0.01, 2)
            cases[f"{prefix}_tramo{i}_upper"] = (upper_boundary, calc_fn(upper_boundary))
        else:
            valor_alto = round(lower + 1_000_000.0, 2)
            cases[f"{prefix}_tramo{i}_valor_alto"] = (valor_alto, calc_fn(valor_alto))
    return cases


isr_pf_mensual_cases = boundary_cases(
    ISR_TABLE_MONTHLY, lambda x: calculate_isr_pf(x, annual=False), "isr_pf_mensual"
)
isr_pf_anual_cases = boundary_cases(
    ISR_TABLE_ANNUAL, lambda x: calculate_isr_pf(x, annual=True), "isr_pf_anual"
)
isr_pm_resico_cases = boundary_cases(
    ISR_PM_MENSUAL_RESICO, lambda x: calculate_isr_pm_resico(x), "isr_pm_resico"
)

for name, (entrada, resultado) in {**isr_pf_mensual_cases, **isr_pf_anual_cases, **isr_pm_resico_cases}.items():
    out[name] = {"entrada": {"baseGravable": entrada}, "resultado": ser(resultado)}

# ===================================================================
# ISR PF — casos adicionales: 0 exacto, negativo, pagos provisionales
# ===================================================================
out["isr_pf_mensual_cero"] = {
    "entrada": {"baseGravable": 0.0},
    "resultado": ser(calculate_isr_pf(0.0, annual=False)),
}
out["isr_pf_mensual_negativo"] = {
    "entrada": {"baseGravable": -50000.0},
    "resultado": ser(calculate_isr_pf(-50000.0, annual=False)),
}
out["isr_pf_mensual_con_pagos_provisionales"] = {
    "entrada": {"baseGravable": 20000.0, "pagosProvisionales": 2000.0},
    "resultado": ser(calculate_isr_pf(20000.0, annual=False, pagos_provisionales=2000.0)),
}

# ===================================================================
# ISR PM — tasa fija 30% (Art. 9 LISR), casos de control
# ===================================================================
out["isr_pm_basico"] = {"entrada": {"utilidadFiscal": 100000.00}, "resultado": ser(calculate_isr_pm(100000.00))}
out["isr_pm_cero"] = {"entrada": {"utilidadFiscal": 0.00}, "resultado": ser(calculate_isr_pm(0.00))}
out["isr_pm_negativo"] = {"entrada": {"utilidadFiscal": -50000.00}, "resultado": ser(calculate_isr_pm(-50000.00))}
out["isr_pm_con_pagos_provisionales"] = {
    "entrada": {"utilidadFiscal": 100000.00, "pagosProvisionales": 10000.00},
    "resultado": ser(calculate_isr_pm(100000.00, pagos_provisionales=10000.00)),
}
# Caso construido para forzar un empate exacto en el segundo decimal (redondeo):
# 333333.33 * 0.30 = 99999.999 -> round(., 2) en Python (verificado: NO resulta ser un
# empate exacto de facto — 99999.999 no está a medio camino entre .99 y 1.00 en el
# float binario más cercano — pero se conserva como caso de control de redondeo puro,
# ver diseño §5).
out["isr_pm_redondeo_tercer_decimal"] = {
    "entrada": {"utilidadFiscal": 333333.33},
    "resultado": ser(calculate_isr_pm(333333.33)),
}

# ===================================================================
# DIOT — casos A/B/C (diseño §4.7)
# ===================================================================

diot_a_invoices = [
    {
        "rfc_emisor": "CON950820K12",
        "nombre_emisor": "PROVEEDOR DE PRUEBA SA DE CV",
        "subtotal": 5000.00,
        "iva_trasladado": 800.00,
        "iva_acreditable": 800.00,
        "tasa_iva": 0.16,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-05",
    },
    {
        "rfc_emisor": "con950820k12",
        "nombre_emisor": "PROVEEDOR DE PRUEBA SA DE CV",
        "subtotal": 3000.00,
        "iva_trasladado": 480.00,
        "iva_acreditable": 480.00,
        "tasa_iva": 0.16,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-12",
    },
    {
        "rfc_emisor": "XAXX010101000",
        "nombre_emisor": "PUBLICO EN GENERAL",
        "subtotal": 999999.00,
        "iva_trasladado": 159999.84,
        "iva_acreditable": 0.0,
        "tasa_iva": 0.16,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-20",
    },
]
out["diot_caso_a_multi_factura_generico_filtrado"] = {
    "entrada": {"invoices": diot_a_invoices, "rfcContribuyente": "DESP010101AB1", "periodo": "2026-07"},
    "resultado": ser(aggregate_diot(diot_a_invoices, "DESP010101AB1", "2026-07")),
}

diot_b_invoices = [
    {
        "rfc_emisor": "EXP900101AB1",
        "nombre_emisor": "EXPORTADORA DE PRUEBA SA DE CV",
        "subtotal": 10000.00,
        "iva_trasladado": 1600.00,
        "iva_acreditable": 1600.00,
        "tasa_iva": 0.16,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-08",
    },
    {
        "rfc_emisor": "EXP900101AB1",
        "nombre_emisor": "EXPORTADORA DE PRUEBA SA DE CV",
        "subtotal": 20000.00,
        "iva_trasladado": 0.0,
        "iva_acreditable": 0.0,
        "tasa_iva": 0.0,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-15",
    },
]
out["diot_caso_b_mismo_rfc_dos_tasas"] = {
    "entrada": {"invoices": diot_b_invoices, "rfcContribuyente": "DESP010101AB1", "periodo": "2026-07"},
    "resultado": ser(aggregate_diot(diot_b_invoices, "DESP010101AB1", "2026-07")),
}

diot_c_invoices = [
    {
        "rfc_emisor": "USA010101XX1",
        "nombre_emisor": "PROVEEDOR EXTRANJERO USD",
        "subtotal": 1000.00,
        "iva_trasladado": 0.0,
        "iva_acreditable": 0.0,
        "tasa_iva": 0.0,
        "tipo_cambio": 18.35,
        "moneda": "USD",
        "fecha": "2026-07-10",
    },
    {
        "rfc_emisor": "FRO010101YY2",
        "nombre_emisor": "PROVEEDOR FRONTERA 8PCT",
        "subtotal": 4000.00,
        "iva_trasladado": 320.00,
        "iva_acreditable": 320.00,
        "tasa_iva": 0.08,
        "tipo_cambio": 1.0,
        "moneda": "MXN",
        "fecha": "2026-07-18",
    },
]
out["diot_caso_c_moneda_extranjera_y_frontera_8pct"] = {
    "entrada": {"invoices": diot_c_invoices, "rfcContribuyente": "DESP010101AB1", "periodo": "2026-07"},
    "resultado": ser(aggregate_diot(diot_c_invoices, "DESP010101AB1", "2026-07")),
}

print(json.dumps(out, indent=2, ensure_ascii=False))
