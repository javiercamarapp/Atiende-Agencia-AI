#!/usr/bin/env python3
"""Agrega los JSONL del banco (run.ts / texto.ts) y los veredictos del juez en tablas markdown + resumen.json.
Uso: python3 reporte.py DIR [prefijo ...]   (prefijos de archivo: v1 = voz cascada, v2 = texto, v3 = Gemini Live)"""
import json, sys, os, glob, statistics, collections

D = sys.argv[1]
prefijos = sys.argv[2:] or ["v1", "v2", "v3"]
CONTROLADOR = {"V08", "V09", "V10", "V13", "V14", "V15"}          # prueban la maquina de llamada, no al modelo (siempre pasan)
SERVIDOR = {"V16", "V21", "V23"}                                    # dependen de provocar fallas/zonas que el prompt no cubre: se reportan aparte
COMANDA_VOZ = {"V01", "V02", "V03", "V04", "V06", "V17", "V20", "V24", "V25", "V27", "V28", "V29", "V30", "V31", "V32"}
ESCALA_VOZ = {"V07", "V22", "V26"}
REGLAS_VOZ = {"V05", "V06"}
NO_APLICA = lambda g: g["grader"] == "G_BARGE_IN" or (g["grader"] == "G_TOOLS" and "no se rechazo" in g["detalle"])  # barge-in no existe por texto; no intentar una accion prohibida es correcto
REGLAS_DURAS_VOZ = {"G_REGLAS_DURAS", "G_SIN_TARJETA", "G_TELEFONO"}
casos_pm = {}
try:
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../packages/domain-restaurantes/src/evals/agente-pm/casos.json")
    for c in json.load(open(p))["casos"]:
        casos_pm[c["id"]] = c
except Exception:
    pass

def pct(a, b): return "-" if b == 0 else f"{100*a/b:.0f}%"
def cuantil(xs, q):
    xs = sorted(x for x in xs if x is not None)
    return None if not xs else xs[min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))]

recs, juez = [], {}
for f in sorted(glob.glob(os.path.join(D, "*.jsonl"))):
    b = os.path.basename(f)
    if b.startswith("juez-"):
        for l in open(f):
            if l.strip():
                j = json.loads(l); juez[j["clave"]] = j.get("juez") or {}
    elif any(b.startswith(p + "-") for p in prefijos):
        for l in open(f):
            if l.strip():
                r = json.loads(l); r["clave"] = f'{r["motor"]}|{r["modelo"]}|{r.get("etiqueta") or ""}|{r["guion"]}|{r["rep"]}'; recs.append(r)

def fallos_efectivos(r): return [f for f in r["fallos"] if not NO_APLICA(f)]
def ok_estricto(r): return not r.get("error") and not fallos_efectivos(r)
def ok_ajustado(r):
    if ok_estricto(r): return True
    if r.get("error"): return False
    v = juez.get(r["clave"], {}).get("veredicto_fallo")
    return v in ("cliente_simulado", "grader")

def idc(r): return r["guion"].split("-")[0]
grupos = collections.OrderedDict()
for r in recs: grupos.setdefault((r["motor"], r["modelo"], r.get("razon"), r.get("etiqueta") or ""), []).append(r)

def resumen(k, rs):
    motor, modelo, razon, et = k
    val = [r for r in rs if not r.get("error")]
    o = {"motor": motor, "modelo": modelo, "razon": razon, "etiqueta": et, "corridas": len(val), "infra": len(rs) - len(val)}
    if not val: return o
    if motor == "texto":
        def grupo(r): return casos_pm.get(r["guion"], {}).get("esperado", {}).get("resultado", "comanda" if r["guion"] == "S1" else "otro")
        nuc = val
        com = [r for r in val if grupo(r) == "comanda"]
        esc = [r for r in val if grupo(r) == "escalar"]
        o["comanda_estricto"] = pct(sum(ok_estricto(r) for r in com), len(com)) + f" n={len(com)}"
        o["comanda_ajustado"] = pct(sum(ok_ajustado(r) for r in com), len(com))
        o["escalamiento"] = pct(sum(ok_ajustado(r) for r in esc), len(esc)) + f" n={len(esc)}"
        o["reglas_duras"] = sum(1 for r in val for f in fallos_efectivos(r) if f["grader"].startswith("G_REGLA_R") or f["grader"] == "G_SEGURIDAD")
        o["reglas_duras_corridas"] = pct(sum(any(f["grader"].startswith("G_REGLA_R") or f["grader"] == "G_SEGURIDAD" for f in fallos_efectivos(r)) for r in val), len(val))
        o["escal_innecesaria"] = pct(sum(any(f["grader"] == "G_SIN_ESCALACION_INNECESARIA" for f in fallos_efectivos(r)) for r in val), len(val))
        o["precio_inv"] = pct(sum(any(f["grader"] == "G_REGLA_R6" for f in fallos_efectivos(r)) for r in val), len(val))
    else:
        nuc = [r for r in val if idc(r) not in CONTROLADOR | SERVIDOR]
        com = [r for r in val if idc(r) in COMANDA_VOZ]
        esc = [r for r in val if idc(r) in ESCALA_VOZ]
        o["comanda_estricto"] = pct(sum(ok_estricto(r) for r in com), len(com)) + f" n={len(com)}"
        o["comanda_ajustado"] = pct(sum(ok_ajustado(r) for r in com), len(com))
        o["escalamiento"] = pct(sum(ok_ajustado(r) for r in esc), len(esc)) + f" n={len(esc)}"
        o["reglas_duras"] = sum(1 for r in val for f in fallos_efectivos(r) if f["grader"] in REGLAS_DURAS_VOZ)
        o["reglas_duras_corridas"] = pct(sum(any(f["grader"] in REGLAS_DURAS_VOZ for f in fallos_efectivos(r)) for r in val), len(val))
        o["escal_innecesaria"] = pct(sum(r["resultado"] == "escalado" and idc(r) in COMANDA_VOZ for r in val), len(val))
        o["precio_inv"] = pct(sum(any(f["grader"] == "G_PRECIO_HABLADO" for f in fallos_efectivos(r)) for r in val), len(val))
        o["servidor_aparte"] = pct(sum(ok_ajustado(r) for r in val if idc(r) in SERVIDOR), sum(1 for r in val if idc(r) in SERVIDOR))
    o["pass_nucleo_estricto"] = pct(sum(ok_estricto(r) for r in nuc), len(nuc))
    o["pass_nucleo_ajustado"] = pct(sum(ok_ajustado(r) for r in nuc), len(nuc))
    por_g = collections.defaultdict(list)
    for r in nuc: por_g[r["guion"]].append(r)
    p1 = [sorted(v, key=lambda r: r["rep"])[0] for v in por_g.values()]
    o["pass@1_ajustado"] = pct(sum(ok_ajustado(r) for r in p1), len(p1))
    full = [v for v in por_g.values() if len(v) >= 2]
    o["pass^N_ajustado"] = pct(sum(all(ok_ajustado(r) for r in v) for v in full), len(full)) + f" (N={min((len(v) for v in full), default=0)})"
    lp = [l["p"] for r in val for l in r.get("latencias", []) if l.get("p") is not None]
    lc = [l["c"] for r in val for l in r.get("latencias", []) if l.get("c") is not None]
    o["ttft_p50_p95_ms"] = f"{cuantil(lp,.5)}/{cuantil(lp,.95)}" if lp else "-"
    o["total_turno_p50_p95_ms"] = f"{cuantil(lc,.5)}/{cuantil(lc,.95)}" if lc else "-"
    dl = [d for r in val for d in r.get("llmDetalle", [])]
    if dl:
        tt = [d["ttft"] for d in dl if d.get("ttft") is not None]
        o["ttft_llm_p50_p95_ms"] = f"{cuantil(tt,.5)}/{cuantil(tt,.95)}"
    cm = [r["costoModeloUsd"] for r in val]
    o["usd_por_corrida"] = round(statistics.mean(cm), 4)
    o["gasto_modelo_usd"] = round(sum(cm), 3)
    o["gasto_cliente_usd"] = round(sum(r.get("costoClienteUsd", 0) for r in val), 3)
    tin = sum(r["tokens"]["in"] for r in val)
    o["tok_in"] = round(tin / len(val)); o["tok_out"] = round(sum(r["tokens"]["out"] for r in val) / len(val))
    o["cache"] = pct(sum(r["tokens"]["cached"] for r in val), tin) if tin else "-"
    o["llm_por_corrida"] = round(sum(r["tokens"]["llamadasLlm"] for r in val) / len(val), 1)
    tv = [r.get("turnosVoz") for r in val if r.get("turnosVoz")]
    if tv: o["turnos_cliente_medio"] = round(statistics.mean(tv), 1); o["usd_por_turno_cliente"] = round(sum(cm) / sum(tv), 5)
    if motor == "gemini":
        mins = [(r["chars"]["agente"] + r["chars"]["cliente"]) / 14 / 60 for r in val]
        o["min_est_medio"] = round(statistics.mean(mins), 2); o["usd_por_min_est"] = round(sum(cm) / sum(mins), 3)
    js = [juez.get(r["clave"]) for r in val if juez.get(r["clave"])]
    if js:
        nat = [j["naturalidad"] for j in js if isinstance(j.get("naturalidad"), (int, float))]
        o["naturalidad_media"] = round(statistics.mean(nat), 2) if nat else None
        o["afirmaciones_falsas"] = pct(sum(bool(j.get("afirmaciones_falsas")) for j in js), len(js))
        o["falla_falsa"] = pct(sum(bool(j.get("falla_falsa")) for j in js), len(js))
        o["juez_n"] = len(js)
    o["fallos_top"] = collections.Counter(f["grader"] for r in val for f in fallos_efectivos(r)).most_common(6)
    o["pass_por_guion"] = {g: f"{sum(ok_ajustado(r) for r in v)}/{len(v)}" for g, v in sorted(por_g.items())}
    return o

res = [resumen(k, v) for k, v in grupos.items()]
json.dump(res, open(os.path.join(D, "resumen.json"), "w"), indent=1, ensure_ascii=False)
COLS = [("modelo", lambda r: r["modelo"].split("/")[-1] + (" " + r["razon"] if r["razon"] else "") + (" +" + r["etiqueta"] if r["etiqueta"] else "")), ("n", "corridas"), ("infra", "infra"), ("comanda estricto", "comanda_estricto"), ("comanda ajustado", "comanda_ajustado"), ("escalamiento", "escalamiento"), ("pass núcleo estr/ajust", lambda r: f'{r["pass_nucleo_estricto"]} / {r["pass_nucleo_ajustado"]}'), ("pass@1", "pass@1_ajustado"), ("pass^N", "pass^N_ajustado"), ("precio inv.", "precio_inv"), ("reglas duras (n / %corr)", lambda r: f'{r["reglas_duras"]} / {r["reglas_duras_corridas"]}'), ("escal. innec.", "escal_innecesaria"), ("afirm. falsas", "afirmaciones_falsas"), ("falla falsa", "falla_falsa"), ("natural. 1-5", "naturalidad_media"), ("TTFT turno p50/p95", "ttft_p50_p95_ms"), ("total turno p50/p95", "total_turno_p50_p95_ms"), ("USD/corrida", "usd_por_corrida"), ("caché", "cache")]
def tabla(motores):
    print("| " + " | ".join(c[0] for c in COLS) + " |"); print("|" + "---|" * len(COLS))
    for r in res:
        if r["motor"] in motores and "pass_nucleo_estricto" in r:
            print("| " + " | ".join(str(c[1](r) if callable(c[1]) else r.get(c[1], "-")) for c in COLS) + " |")
print("## VOZ por cascada (LLM + herramientas por texto)"); tabla({"cascada"})
print("\n## VOZ nativa (Gemini 3.8 Live)"); tabla({"gemini"})
print("\n## TEXTO / WhatsApp"); tabla({"texto"})
print("\n### Fallos efectivos más frecuentes")
for r in res:
    if "fallos_top" in r: print(f"- {r['motor']}:{r['modelo'].split('/')[-1]} {r['etiqueta']}: {r['fallos_top']}")
