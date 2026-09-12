# Generador del golden-set numérico de NÓMINA (Fase 3 despachos) — mismo
# mecanismo que golden_gen_declaraciones.py (Fase 2): se ejecuta UNA VEZ contra
# el intérprete real del repo `despachos` (venv con las dependencias instaladas
# en despachos/.venv) para producir golden-nomina-output.json, que queda
# congelado y versionado junto a este script. Correrlo de nuevo (requiere el
# checkout de despachos en la ruta de abajo + su venv) debe reproducir
# EXACTAMENTE el mismo JSON — si no lo hace, el Python original cambió, no el
# golden.
#
#   /Users/javiercamaraportepetit/Desktop/supabase/despachos/.venv/bin/python3 \
#       golden_gen_nomina.py > golden-nomina-output.json
#
# Fuente de verdad (diseño Fase 3 §1-2): el motor de nómina que el sistema de
# referencia expone en /nomina-completa/* y /nomina/* (mismo motor, ver
# diseño §1) es `b2b_ai.features.nomina_completa.service`. El ISR de nómina lo
# resuelve `b2b_ai.features.compliance.calculate_isr` — DISTINTO de
# `declaraciones.engine.calculate_isr_pf` que Fase 2 ya portó — con su propio
# algoritmo de clasificación de tramo (lower<=x<=upper, usa el upper PROPIO de
# la fila) y su propia tabla (alias engañoso "2024" -> contenido real 2026).
#
# Cada caso se guarda como {"entrada": ..., "resultado": ...} para que el lado
# TypeScript no tenga que re-derivar el input a mano desde el output.
import sys
import json
from dataclasses import asdict

sys.path.insert(0, "/Users/javiercamaraportepetit/Desktop/supabase/despachos")

from b2b_ai.fiscal_tables import (  # noqa: E402
    ISR_MENSUAL_2026,
    ISR_ANUAL_2026,
    UMA_MENSUAL_2026,
    SUBSIDIO_EMPLEO_MENSUAL_2026,
    SUBSIDIO_EMPLEO_QUINCENAL_2026,
)
from b2b_ai.features.compliance import calculate_isr  # noqa: E402
from b2b_ai.features.nomina_completa.service import (  # noqa: E402
    calculate_taxes,
    _calcular_imss_obrero,
    _calcular_imss_patronal,
    _calcular_infonavit,
    _sbc_diario_topado,
    _calcular_subsidio,
    process_payroll,
    calculate_aguinaldo,
    calculate_prima_vacacional,
)
from b2b_ai.features.nomina_completa.models import PayrollTaxes  # noqa: E402


def ser(o):
    if hasattr(o, "to_dict"):
        return o.to_dict()
    return asdict(o)


out = {}

# ===================================================================
# GRUPO A — ISR nómina: límites de tramo usando el upper PROPIO de cada fila
# (a diferencia de declaraciones/engine.py, que usa el lower de la fila
# siguiente). Generado programáticamente desde la tabla real, no a mano.
# ===================================================================


def boundary_cases_isr(table, annual, prefix):
    cases = {}
    n = len(table)
    for i, row in enumerate(table):
        lower = row[0]
        upper = row[1]
        cases[f"{prefix}_tramo{i}_lower"] = (lower, calculate_isr(lower, annual=annual))
        if upper != float("inf"):
            cases[f"{prefix}_tramo{i}_upper"] = (upper, calculate_isr(upper, annual=annual))
        else:
            valor_alto = round(lower + 1_000_000.0, 2)
            cases[f"{prefix}_tramo{i}_valor_alto"] = (valor_alto, calculate_isr(valor_alto, annual=annual))
    return cases


for name, (entrada, resultado) in boundary_cases_isr(ISR_MENSUAL_2026, False, "isr_nomina_mensual").items():
    out[name] = {"entrada": {"gravable": entrada, "annual": False}, "resultado": {"isr": resultado}}

for name, (entrada, resultado) in boundary_cases_isr(ISR_ANUAL_2026, True, "isr_nomina_anual").items():
    out[name] = {"entrada": {"gravable": entrada, "annual": True}, "resultado": {"isr": resultado}}

out["isr_nomina_mensual_cero"] = {"entrada": {"gravable": 0.0, "annual": False}, "resultado": {"isr": calculate_isr(0.0)}}
out["isr_nomina_mensual_negativo"] = {"entrada": {"gravable": -50000.0, "annual": False}, "resultado": {"isr": calculate_isr(-50000.0)}}

# ===================================================================
# GRUPO B — el "hueco" de clasificación de tramo por precisión de punto
# flotante (CRÍTICO, diseño §5.1). Reconstruye el upper de cada tramo vía
# aritmética de floats matemáticamente igual pero no bit-a-bit igual
# (a = upper/denom; a*denom), buscando en varios denominadores — igual que
# `salario_diario*30+benefits` puede reconstruir un valor "igual" en
# decimal pero distinto en binario. Búsqueda EMPÍRICA, no asumida: se
# registra únicamente lo que el intérprete real reproduce como hueco.
# ===================================================================


def find_float_holes(table, annual, prefix):
    cases = {}
    for i, row in enumerate(table):
        upper = row[1]
        if upper == float("inf"):
            continue
        literal_isr = calculate_isr(upper, annual=annual)
        for denom in [3, 6, 7, 9, 11, 13, 17, 30, 90]:
            a = upper / denom
            recon = a * denom
            if recon == upper:
                continue
            recon_isr = calculate_isr(recon, annual=annual)
            if recon_isr != literal_isr:
                cases[f"{prefix}_tramo{i}_hole_denom{denom}"] = (recon, recon_isr, literal_isr, upper)
                break  # un caso reproducible por tramo basta
    return cases


for name, (entrada, resultado, isr_esperado_sin_hueco, upper_literal) in find_float_holes(ISR_MENSUAL_2026, False, "isr_nomina_mensual").items():
    out[name] = {
        "entrada": {"gravable": entrada, "annual": False},
        "resultado": {"isr": resultado},
        "nota": f"upper literal {upper_literal} da isr={isr_esperado_sin_hueco}; la reconstrucción de punto flotante cae en el hueco y da isr={resultado} (0.0, retención perdida en silencio)",
    }

for name, (entrada, resultado, isr_esperado_sin_hueco, upper_literal) in find_float_holes(ISR_ANUAL_2026, True, "isr_nomina_anual").items():
    out[name] = {
        "entrada": {"gravable": entrada, "annual": True},
        "resultado": {"isr": resultado},
        "nota": f"upper literal {upper_literal} da isr={isr_esperado_sin_hueco}; la reconstrucción de punto flotante cae en el hueco y da isr={resultado} (0.0, retención perdida en silencio)",
    }

# ===================================================================
# GRUPO C — IMSS / INFONAVIT
# ===================================================================
uma_diaria = round(float(UMA_MENSUAL_2026) / 30.4, 2)
tope_sbc = uma_diaria * 25.0

imss_casos_salario = {
    "sbc_minimo_1": 1.0,
    "sbc_uma_exacta": uma_diaria,
    "sbc_tope_exacto": tope_sbc,
    "sbc_tope_menos_1_centavo": round(tope_sbc - 0.01, 2),
    "sbc_tope_mas_1000": tope_sbc + 1000.0,
    "sbc_cero": 0.0,
    "sbc_negativo": -100.0,
}
for nombre, salario_diario in imss_casos_salario.items():
    for dias in [15, 30, 31]:
        out[f"imss_{nombre}_dias{dias}"] = {
            "entrada": {"salarioDiario": salario_diario, "diasPagados": dias},
            "resultado": {
                "sbcDiarioTopado": _sbc_diario_topado(salario_diario),
                "imssObrero": _calcular_imss_obrero(salario_diario, dias),
                "imssPatronal": _calcular_imss_patronal(salario_diario, dias),
                "infonavit": _calcular_infonavit(salario_diario, dias),
            },
        }

# ===================================================================
# GRUPO D — Subsidio al empleo (11 tramos mensuales, límites, y quincenal)
# ===================================================================


def boundary_cases_subsidio(table, periodicidad, prefix):
    cases = {}
    n = len(table)
    for i, row in enumerate(table):
        lower = float(row[0])
        upper = float(row[1])
        r_lower = _calcular_subsidio(lower, periodicidad)
        r_upper = _calcular_subsidio(upper, periodicidad)
        cases[f"{prefix}_tramo{i}_lower"] = (lower, r_lower)
        cases[f"{prefix}_tramo{i}_upper"] = (upper, r_upper)
    return cases


for name, (entrada, resultado) in boundary_cases_subsidio(SUBSIDIO_EMPLEO_MENSUAL_2026, "mensual", "subsidio_mensual").items():
    out[name] = {"entrada": {"ingresoGravado": entrada, "periodicidad": "mensual"}, "resultado": resultado}

for name, (entrada, resultado) in boundary_cases_subsidio(SUBSIDIO_EMPLEO_QUINCENAL_2026, "quincenal", "subsidio_quincenal").items():
    out[name] = {"entrada": {"ingresoGravado": entrada, "periodicidad": "quincenal"}, "resultado": resultado}

ultimo_tramo_mensual_upper = float(SUBSIDIO_EMPLEO_MENSUAL_2026[-1][1])
out["subsidio_mensual_arriba_del_ultimo_tramo"] = {
    "entrada": {"ingresoGravado": round(ultimo_tramo_mensual_upper + 1000.0, 2), "periodicidad": "mensual"},
    "resultado": _calcular_subsidio(round(ultimo_tramo_mensual_upper + 1000.0, 2), "mensual"),
}
out["subsidio_mensual_cero"] = {"entrada": {"ingresoGravado": 0.0, "periodicidad": "mensual"}, "resultado": _calcular_subsidio(0.0, "mensual")}
out["subsidio_mensual_negativo"] = {"entrada": {"ingresoGravado": -500.0, "periodicidad": "mensual"}, "resultado": _calcular_subsidio(-500.0, "mensual")}

# ===================================================================
# GRUPO E — calculate_taxes end-to-end
# ===================================================================
e2e_casos = {
    "salario_minimo_sbc_uma": {"salary": 0.0, "benefits": 0.0, "salary_per_day": uma_diaria, "dias_pagados": 30},
    "salario_medio_15000": {"salary": 15000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_topa_sbc": {"salary": 0.0, "benefits": 0.0, "salary_per_day": tope_sbc + 500.0, "dias_pagados": 30},
    "salario_anula_subsidio": {"salary": 20000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_con_subsidio_activo": {"salary": 3000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_con_benefits": {"salary": 15000.0, "benefits": 2000.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_quincenal_vs_mensual_base": {"salary": 0.0, "benefits": 0.0, "salary_per_day": 1000.0, "dias_pagados": 15, "periodicidad": "mensual"},
    "salario_quincenal_real": {"salary": 0.0, "benefits": 0.0, "salary_per_day": 1000.0, "dias_pagados": 15, "periodicidad": "quincenal"},
    "salario_cero": {"salary": 0.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_negativo": {"salary": -10000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
    "salario_dias31": {"salary": 15000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 31},
    "salario_alto_500000": {"salary": 500000.0, "benefits": 0.0, "salary_per_day": 0.0, "dias_pagados": 30},
}
for nombre, params in e2e_casos.items():
    taxes = calculate_taxes(
        salary=params["salary"],
        benefits=params.get("benefits", 0.0),
        salary_per_day=params.get("salary_per_day", 0.0),
        dias_pagados=params.get("dias_pagados", 30),
        periodicidad=params.get("periodicidad", "mensual"),
    )
    out[f"e2e_{nombre}"] = {
        "entrada": {
            "salary": params["salary"],
            "benefits": params.get("benefits", 0.0),
            "salaryPerDay": params.get("salary_per_day", 0.0),
            "diasPagados": params.get("dias_pagados", 30),
            "periodicidad": params.get("periodicidad", "mensual"),
        },
        "resultado": ser(taxes),
    }

# cociente (isr+imss_obrero)/bruto para $500,000 — demuestra que el guard de
# 40% jamás se dispara (diseño §5.3)
taxes_500k = calculate_taxes(salary=500000.0)
cociente_500k = round((taxes_500k.isr + taxes_500k.imss_obrero) / 500000.0, 4)
out["e2e_cociente_500000_no_dispara_guard"] = {
    "entrada": {"salary": 500000.0},
    "resultado": {"cociente": cociente_500k, "isr": taxes_500k.isr, "imss_obrero": taxes_500k.imss_obrero},
}

# ===================================================================
# GRUPO F — process_payroll (idempotencia, requires_human_review, tenant_id
# ausente formateado como "None" en el idempotency_key — f-string real de
# Python, no una convención inventada por el port)
# ===================================================================
period = {"month": 7, "year": 2026, "dias_pagados": 30}
employees = [
    {"employee_id": "E1", "nombre": "Empleado Uno", "salario_bruto": 15000.0, "percepciones": 0.0, "banco": "BBVA", "clabe": "012180000000000001"},
    {"employee_id": "E2", "nombre": "Empleado Dos", "salario_bruto": 30000.0, "percepciones": 1000.0, "banco": "Santander", "clabe": "012180000000000002"},
]
resultado_1 = process_payroll(period, employees, tenant_id=42)
resultado_2 = process_payroll(period, employees, tenant_id=42)
out["process_payroll_basico"] = {
    "entrada": {"period": period, "employees": employees, "tenant_id": 42},
    "resultado": ser(resultado_1),
}
out["process_payroll_idempotencia"] = {
    "entrada": {"period": period, "employees": employees, "tenant_id": 42},
    "resultado": {"idempotency_key_1": resultado_1.idempotency_key, "idempotency_key_2": resultado_2.idempotency_key, "iguales": resultado_1.idempotency_key == resultado_2.idempotency_key},
}
resultado_sin_tenant = process_payroll(period, employees, tenant_id=None)
out["process_payroll_sin_tenant_id"] = {
    "entrada": {"period": period, "employees": employees, "tenant_id": None},
    "resultado": {"idempotency_key": resultado_sin_tenant.idempotency_key},
}

# Empleado con salario extremo para demostrar que requires_human_review NUNCA
# se activa (asíntota matemática en 35%, diseño §5.3) — ni con $1,000,000.
employees_extremo = [
    {"employee_id": "E3", "nombre": "Empleado Extremo", "salario_bruto": 1000000.0, "percepciones": 0.0, "banco": "X", "clabe": "0"},
]
resultado_extremo = process_payroll(period, employees_extremo, tenant_id=1)
out["process_payroll_extremo_no_dispara_review"] = {
    "entrada": {"period": period, "employees": employees_extremo, "tenant_id": 1},
    "resultado": {
        "requires_human_review": resultado_extremo.requires_human_review,
        "total_bruto": resultado_extremo.total_bruto,
        "total_deducciones": resultado_extremo.total_deducciones,
        "cociente": round(resultado_extremo.total_deducciones / resultado_extremo.total_bruto, 6),
    },
}

# ===================================================================
# GRUPO G — aguinaldo / prima vacacional
# ===================================================================
out["aguinaldo_cero_dias"] = {"entrada": {"salarioDiario": 500.0, "diasAguinaldo": 0}, "resultado": {"aguinaldo": calculate_aguinaldo(500.0, 0)}}
out["aguinaldo_negativo"] = {"entrada": {"salarioDiario": -500.0, "diasAguinaldo": 15}, "resultado": {"aguinaldo": calculate_aguinaldo(-500.0, 15)}}
out["aguinaldo_estandar_15dias"] = {"entrada": {"salarioDiario": 500.0, "diasAguinaldo": 15}, "resultado": {"aguinaldo": calculate_aguinaldo(500.0)}}
out["prima_vacacional_cero_dias"] = {"entrada": {"salarioDiario": 500.0, "diasVacaciones": 0}, "resultado": {"primaVacacional": calculate_prima_vacacional(500.0, 0)}}
out["prima_vacacional_negativo"] = {"entrada": {"salarioDiario": -500.0, "diasVacaciones": 6}, "resultado": {"primaVacacional": calculate_prima_vacacional(-500.0)}}
out["prima_vacacional_estandar_6dias_25pct"] = {"entrada": {"salarioDiario": 500.0, "diasVacaciones": 6, "porcentaje": 0.25}, "resultado": {"primaVacacional": calculate_prima_vacacional(500.0)}}

print(json.dumps(out, indent=2, ensure_ascii=False))
