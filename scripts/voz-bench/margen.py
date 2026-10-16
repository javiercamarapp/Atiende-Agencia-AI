#!/usr/bin/env python3
"""Recalcula el modelo de costos de pm/costos_arquitectura_2026.py con parametros MEDIDOS por el banco.
Uso: python3 margen.py DIR_RESULTADOS PARAMS_JSON_DE_LA_INVESTIGACION"""
import json, sys, os, glob, statistics, collections
D, PJ = sys.argv[1], sys.argv[2]
P = json.load(open(PJ))
FX, CALLS, MIN, FIJO = P["fx"], P["calls"], P["call_min"], P["fixed_month_per_client"]
REV = P["price_mxn"] / FX
CHARS_LLAMADA = MIN * P["agent_frac"] * P["chars_per_min"]
TEL = P["tel_per_min"] * MIN
STT = 0.0061 * MIN          # Deepgram Nova-3 es + keyterms (NO medido: precio de lista de la investigacion)
TTS = {"Deepgram Aura-2 $30/M": 30, "ElevenLabs v4 Turbo $40/M": 40, "Inworld Flash $15/M": 15, "Gemini 3.8 Flash TTS $13.6/M (medido, pero 2.8 s)": 13.55}

recs = collections.defaultdict(list)
for f in glob.glob(os.path.join(D, "v1-voz-*.jsonl")) + glob.glob(os.path.join(D, "v3-*.jsonl")):
    for l in open(f):
        if l.strip():
            r = json.loads(l)
            if not r.get("error"): recs[(r["motor"], r["modelo"], r.get("razon"), r.get("etiqueta") or "")].append(r)

def ajuste(rs):
    """Costo del modelo en funcion de los turnos del cliente: c(t) = a*t + b*t^2 (el contexto crece, el costo no es lineal). Minimos cuadrados sin termino constante."""
    rs = [r for r in rs if r.get("turnosVoz")]
    xs = [float(r["turnosVoz"]) for r in rs]; ys = [r["costoModeloUsd"] for r in rs]
    s11 = sum(x * x for x in xs); s12 = sum(x ** 3 for x in xs); s22 = sum(x ** 4 for x in xs)
    b1 = sum(x * y for x, y in zip(xs, ys)); b2 = sum(x * x * y for x, y in zip(xs, ys))
    det = s11 * s22 - s12 * s12
    return (b1 * s22 - b2 * s12) / det, (s11 * b2 - s12 * b1) / det, sum(xs) / len(xs), len(rs)

TURNOS = int(os.environ.get("VOZ_TURNOS_LLAMADA", "8"))   # turnos del cliente en una llamada de 2.5 min (supuesto; sensibilidad 6-12)
filas = []
for k, rs in sorted(recs.items()):
    motor, modelo, razon, et = k
    if len(rs) < 20 and motor == "cascada": continue
    a, b, tm, n = ajuste(rs)
    nombre = f'{modelo.split("/")[-1]} {razon or ""} {et}'.strip()
    filas.append((motor, nombre, a * TURNOS + b * TURNOS ** 2, (a, b), tm, n))

def fmt(n): return f"{n:,.0f}"
out = []
out.append(f"Parametros: PM {CALLS} llamadas/mes de {MIN} min = {fmt(CALLS*MIN)} min; ingreso MXN {fmt(P['price_mxn'])} sin IVA = US${REV:,.0f} (FX {FX}); fijos US${FIJO}/cliente; tel US${P['tel_per_min']}/min; STT US$0.0061/min (lista, NO medido); voz del agente {CHARS_LLAMADA:.0f} caracteres/llamada.\n")
out.append(f"### Costo por llamada de 2.5 min ({TURNOS} turnos del cliente) y margen con PM (1 cliente)\n")
out.append("| Configuracion | LLM (medido) | STT | TTS | Tel | **Total/llamada** | **Mes** (3,680) | + fijos | **Margen** |")
out.append("|---|---|---|---|---|---|---|---|---|")
resumen = []
for motor, nombre, llm, ab, tm, n in filas:
    if motor == "gemini":
        total = llm + TEL
        mes = total * CALLS
        marg = 1 - (mes + FIJO) / REV
        out.append(f"| **Gemini 3.8 Live nativa** ({n} llamadas medidas, {tm:.1f} turnos de cliente en promedio; costo evaluado a {TURNOS} turnos) | {llm:.3f} (todo incluido: oye + habla) | - | - | {TEL:.3f} | {total:.3f} | US${fmt(mes)} | US${fmt(mes+FIJO)} | {marg*100:.0f}% |")
        resumen.append((nombre, total, mes, marg))
    else:
        for tn, tp in TTS.items():
            tts = CHARS_LLAMADA * tp / 1e6
            total = llm + STT + tts + TEL
            mes = total * CALLS
            marg = 1 - (mes + FIJO) / REV
            out.append(f"| Cascada {nombre} + {tn} | {llm:.4f} | {STT:.3f} | {tts:.3f} | {TEL:.3f} | {total:.3f} | US${fmt(mes)} | US${fmt(mes+FIJO)} | {marg*100:.0f}% |")
            resumen.append((nombre + " + " + tn, total, mes, marg))
out.append("\n### Margen con 10 / 50 / 100 clientes iguales a PM (fijos de plataforma de la investigacion: " + json.dumps(P["platform_fixed"]) + ")\n")
out.append("| Configuracion | 10 clientes | 50 clientes | 100 clientes |")
out.append("|---|---|---|---|")
for nombre, total, mes, marg in resumen:
    cel = []
    for n in (10, 50, 100):
        tot = n * (mes + FIJO) + P["platform_fixed"].get(str(n), 0)
        cel.append(f"US${fmt(tot)} ({100*(1-tot/(n*REV)):.0f}%)")
    out.append(f"| {nombre} | " + " | ".join(cel) + " |")
out.append("\n### Sensibilidad del costo del MODELO por llamada al numero de turnos del cliente\n")
out.append("| Configuracion | 6 turnos | 8 | 10 | 12 | 14 |"); out.append("|---|---|---|---|---|---|")
for motor, nombre, llm, (a, b), tm, n in filas:
    out.append(f"| {motor} {nombre} | " + " | ".join(f"{a*t+b*t*t:.4f}" for t in (6, 8, 10, 12, 14)) + " |")
print("\n".join(out))
