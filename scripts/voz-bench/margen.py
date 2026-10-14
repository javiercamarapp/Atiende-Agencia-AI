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
TTS = {"ElevenLabs v4 Turbo $40/M": 40, "Inworld Flash $15/M": 15, "Gemini 3.8 Flash TTS $13.6/M (medido)": 13.55}

recs = collections.defaultdict(list)
for f in glob.glob(os.path.join(D, "v1-voz-*.jsonl")) + glob.glob(os.path.join(D, "v3-*.jsonl")):
    for l in open(f):
        if l.strip():
            r = json.loads(l)
            if not r.get("error"): recs[(r["motor"], r["modelo"], r.get("razon"), r.get("etiqueta") or "")].append(r)

def por_min(rs):
    """USD de modelo por minuto de conversacion hablada (14 caracteres/s, 170 palabras/min) y turnos de cliente por minuto."""
    mins = sum((r["chars"]["agente"] + r["chars"]["cliente"]) / 14 / 60 for r in rs)
    cost = sum(r["costoModeloUsd"] for r in rs)
    turnos = sum(r.get("turnosVoz") or 0 for r in rs)
    return cost / mins, turnos / mins, mins / len(rs)

filas = []
for k, rs in sorted(recs.items()):
    motor, modelo, razon, et = k
    if len(rs) < 20 and motor == "cascada": continue
    usd_min, turnos_min, min_corrida = por_min(rs)
    llm_llamada = usd_min * MIN
    nombre = f'{modelo.split("/")[-1]} {razon or ""} {et}'.strip()
    filas.append((motor, nombre, llm_llamada, usd_min, turnos_min, min_corrida, len(rs)))

def fmt(n): return f"{n:,.0f}"
out = []
out.append(f"Parametros: PM {CALLS} llamadas/mes de {MIN} min = {fmt(CALLS*MIN)} min; ingreso MXN {fmt(P['price_mxn'])} sin IVA = US${REV:,.0f} (FX {FX}); fijos US${FIJO}/cliente; tel US${P['tel_per_min']}/min; STT US$0.0061/min (lista, NO medido); voz del agente {CHARS_LLAMADA:.0f} caracteres/llamada.\n")
out.append("### Costo por llamada de 2.5 min y margen con PM (1 cliente)\n")
out.append("| Configuracion | LLM (medido) | STT | TTS | Tel | **Total/llamada** | **Mes** (3,680) | + fijos | **Margen** |")
out.append("|---|---|---|---|---|---|---|---|---|")
resumen = []
for motor, nombre, llm, usd_min, tm, mc, n in filas:
    if motor == "gemini":
        total = llm + TEL
        mes = total * CALLS
        marg = 1 - (mes + FIJO) / REV
        out.append(f"| **Gemini 3.8 Live nativa** ({n} llamadas medidas, {mc:.1f} min c/u) | {llm:.3f} (todo incluido: oye + habla) | - | - | {TEL:.3f} | {total:.3f} | US${fmt(mes)} | US${fmt(mes+FIJO)} | {marg*100:.0f}% |")
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
print("\n".join(out))
