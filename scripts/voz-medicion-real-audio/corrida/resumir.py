#!/usr/bin/env python3
"""Resumen de la medicion E2E de voz por etiqueta (r2, r3...): aprobacion (Wilson 95 %), latencia p50/p95 recibida por la red,
min y turnos por llamada, caracteres TTS, costo por proveedor (ElevenLabs creditos reales, OpenRouter USD real de generacion,
LiveKit minutos) y causas de falla. Las llamadas con falla de INFRAESTRUCTURA local (excepcion de LiveKit, `apps_api_error_interno` del Postgres local, resultado api_no_disponible) se cuentan aparte:
la columna «sin infra» es la tasa del agente. Uso: resumir.py <dir results> <etiqueta>... [--md] [--fallas]"""
import json, math, sys, glob, os, collections

def wilson(k, n, z=1.96):
    if n == 0: return (0, 0)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)

def pct(v, q):
    if not v: return None
    v = sorted(v); i = (len(v) - 1) * q; lo = math.floor(i); hi = math.ceil(i)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)

def cargar(d, etq):
    out = []
    for f in sorted(glob.glob(f"{d}/voz-e2e-{etq}-rep*.json")):
        try: out += json.load(open(f))
        except Exception: pass
    return out

def es_infra(r):
    return bool(r.get("excepcion") or r.get("infra") or r.get("resultado") == "api_no_disponible")

def resumen(rs):
    val = [r for r in rs if not r.get("excepcion")]
    k = sum(1 for r in val if r["veredicto"] == "PASA"); n = len(val)
    ag = [r for r in val if not es_infra(r)]; k_ag = sum(1 for r in ag if r["veredicto"] == "PASA")
    # < 250 ms = el agente ya estaba sonando cuando el cliente termino (traslape), no es una respuesta: se excluye y se cuenta aparte.
    lat_all = [x for r in val for x in (r.get("latenciasMs") or [])]
    lat = [x for x in lat_all if x >= 250]
    lat_r = [x for r in val for x in (r.get("latenciasRespuestaMs") or []) if x >= 250]
    mins = [r["durS"] / 60 for r in val if r.get("durS")]
    tts_chars = []; el_cred = []; or_agente = []; or_cj = []; worker_usd = []
    for r in val:
        comp = r.get("costoComponentes") or []
        tts_chars.append(sum(c["n"] for c in comp if c["p"] in ("elevenlabs-tts", "deepgram-aura-2")))
        or_agente.append(sum(c["usd"] for c in comp if c["p"].startswith("openrouter:")))
        worker_usd.append(sum(c["usd"] for c in comp))
        if r.get("creditosEl") is not None: el_cred.append(r["creditosEl"])
        or_cj.append(r.get("clienteJuezUsd") or 0)
    tot_min = sum(mins)
    return dict(n_ag=len(ag), k_ag=k_ag, w_ag=wilson(k_ag, len(ag)), n=n, exc=len(rs) - n, k=k, w=wilson(k, n), p50=pct(lat, .5), p95=pct(lat, .95), r50=pct(lat_r, .5), r95=pct(lat_r, .95), nlat=len(lat), ntras=len(lat_all) - len(lat),
                min_ll=tot_min / n if n else 0, tot_min=tot_min, turnos=sum(r.get("turnosCliente", 0) for r in val) / n if n else 0,
                tts=sum(tts_chars) / n if n else 0, el=sum(el_cred), el_n=len(el_cred), or_ag=sum(or_agente), or_cj=sum(or_cj),
                worker=sum(worker_usd), lk_min=2 * tot_min)

def main():
    a = [x for x in sys.argv[1:] if not x.startswith("--")]; d, etqs = a[0], a[1:]
    print("| condicion | llamadas (exc) | aprobadas | Wilson 95 % | sin infra (Wilson) | p50/p95 s (turnos) | respuesta (no relleno) p50/p95 s | min/llamada | turnos/llamada | caracteres TTS/llamada | ElevenLabs creditos/llamada (/min) | OpenRouter agente USD/llamada | OpenRouter cliente+juez USD/llamada | costo worker USD/min · /llamada | LiveKit min-participante |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for e in etqs:
        rs = cargar(d, e); s = resumen(rs); n = s["n"] or 1
        f = lambda v: "-" if v is None else f"{v/1000:.1f}"
        elpl = s["el"] / s["el_n"] if s["el_n"] else float("nan")
        print(f"| {e} | {s['n']} ({s['exc']}) | {s['k']}/{s['n']} = {100*s['k']/n:.0f} % | {100*s['w'][0]:.0f}–{100*s['w'][1]:.0f} % | {s['k_ag']}/{s['n_ag']} ({100*s['w_ag'][0]:.0f}–{100*s['w_ag'][1]:.0f} %) | {f(s['p50'])} / {f(s['p95'])} ({s['nlat']}; {s['ntras']} traslapes) | {f(s['r50'])} / {f(s['r95'])} | {s['min_ll']:.2f} | {s['turnos']:.1f} | {s['tts']:.0f} | {elpl:.0f} ({s['el']/s['tot_min'] if s['tot_min'] else 0:.0f}) | {s['or_ag']/n:.4f} | {s['or_cj']/n:.4f} | {s['worker']/s['tot_min'] if s['tot_min'] else 0:.4f} · {s['worker']/n:.3f} | {s['lk_min']:.1f} |")
    if "--fallas" in sys.argv:
        for e in etqs:
            print(f"\n### {e}")
            for r in cargar(d, e):
                if r["veredicto"] != "PASA":
                    print(f"- {r['id']} rep{r['rep']} {'[INFRA] ' if es_infra(r) else ''}[{r.get('causa')}/{r.get('juez')}] {str(r.get('motivo'))[:220]} | HARD: {'; '.join(r.get('hard') or [])[:200]} | grab: {r.get('grabacion','-')}")

main()
