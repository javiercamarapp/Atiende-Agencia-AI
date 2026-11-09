#!/usr/bin/env python3
"""Analizador del arnes de voz con audio real. Uso: python3 analizar-audio.py <carpeta o archivo(s) voz-audio-*.json> [--md]
Tabla de latencia POR ETAPA con STT y TTS incluidos (por turno del cliente, p50/p95/max), WER, errores de cifras/terminos del menu/direcciones, interrupciones, finales perdidos,
acierto del juez y costo real de Deepgram (minutos x tarifa y caracteres x tarifa, calculado por el arnes). Solo biblioteca estandar (python 3.9)."""
import glob, json, math, os, sys

def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    return xs[min(len(xs) - 1, int(p * len(xs)))]

def f(x, d=0, suf=""):
    return "-" if x is None else (f"{x:.{d}f}{suf}")

def cargar(args):
    archivos = []
    for a in args:
        if os.path.isdir(a): archivos += sorted(glob.glob(os.path.join(a, "voz-audio-*.json")))
        elif os.path.exists(a): archivos.append(a)
    filas = []
    for a in archivos:
        try: j = json.load(open(a))
        except Exception: continue
        if isinstance(j, list):
            ok = [r for r in j if isinstance(r, dict) and not r.get("excepcion")]
            for r in ok: r["_archivo"] = a
            filas += ok
    return archivos, filas

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    md = "--md" in sys.argv
    archivos, filas = cargar(args)
    if not filas:
        print("sin resultados"); sys.exit(1)
    turnos = [t for r in filas for t in r.get("turnosAudio", [])]
    etapas = [("STT: fin de voz -> final del STT", "sttMs"), ("LLM: final STT -> 1a frase al TTS", "llmMs"), ("TTS: 1a frase -> 1er audio (Aura-2)", "ttsMs"), ("TOTAL: fin de voz -> 1er audio del agente", "totalMs")]
    out = []
    ruidos = sorted({r.get("ruidoAudio") for r in filas})
    out.append(f"Llamadas: {len(filas)} | turnos del cliente: {len(turnos)} | ruido de audio: {ruidos} | endpointing: {filas[0].get('endpointingMs')} ms | keyterms enviados: {filas[0].get('keytermsEnviados')}")
    out.append("")
    out.append("LATENCIA POR TURNO (ms)" + (" -- tabla" if md else ""))
    cab = ["etapa", "n", "p50", "p95", "max"]
    rows = []
    for nombre, k in etapas:
        xs = [t[k] for t in turnos if t.get(k) is not None]
        rows.append([nombre, str(len(xs)), f(pct(xs, .5)), f(pct(xs, .95)), f(max(xs) if xs else None)])
    sep = "|" if md else "  "
    if md:
        out.append("| " + " | ".join(cab) + " |"); out.append("|" + "---|" * len(cab))
        out += ["| " + " | ".join(r) + " |" for r in rows]
    else:
        w = [max(len(r[i]) for r in rows + [cab]) for i in range(len(cab))]
        out.append("  ".join(c.ljust(w[i]) for i, c in enumerate(cab)))
        out += ["  ".join(r[i].ljust(w[i]) for i in range(len(cab))) for r in rows]
    stt = [t["sttMs"] for t in turnos if t.get("sttMs") is not None]
    ep = filas[0].get("endpointingMs") or 0
    out.append(f"(el STT incluye el endpointing de {ep} ms; STT neto aprox p50 = {f(pct(stt, .5) - ep if stt else None)} ms)")
    # por llamada: mediana del total de cada llamada, y su p50/p95 entre llamadas
    med = []
    for r in filas:
        xs = sorted(t["totalMs"] for t in r.get("turnosAudio", []) if t.get("totalMs") is not None)
        if xs: med.append(xs[len(xs) // 2])
    out.append(f"POR LLAMADA (mediana del total de cada llamada): p50={f(pct(med, .5))} ms p95={f(pct(med, .95))} ms (n={len(med)})")
    out.append("")
    N = sum(t["wer"]["n"] for t in turnos); E = sum(t["wer"]["s"] + t["wer"]["d"] + t["wer"]["i"] for t in turnos)
    S = sum(t["wer"]["s"] for t in turnos); Dl = sum(t["wer"]["d"] for t in turnos); I = sum(t["wer"]["i"] for t in turnos)
    dirs = [t for t in turnos if t.get("direccion")]
    Nd = sum(t["wer"]["n"] for t in dirs); Ed = sum(t["wer"]["s"] + t["wer"]["d"] + t["wer"]["i"] for t in dirs)
    nn = sum(t["numeros"]["n"] for t in turnos); ne = sum(t["numeros"]["errores"] for t in turnos)
    tn = sum(t["terminos"]["n"] for t in turnos); te = sum(t["terminos"]["errores"] for t in turnos)
    dn = sum(t["numeros"]["n"] for t in dirs); de = sum(t["numeros"]["errores"] for t in dirs)
    out.append("EXACTITUD DEL STT (original del cliente vs transcrito)")
    out.append(f"  WER global: {f(100 * E / N if N else None, 1, '%')}  (sust {S}, borr {Dl}, ins {I} sobre {N} palabras)")
    out.append(f"  WER en turnos con direccion: {f(100 * Ed / Nd if Nd else None, 1, '%')} ({len(dirs)} turnos) | cifras mal en direcciones: {de}/{dn}")
    out.append(f"  Cifras: {ne}/{nn} mal ({f(100 * ne / nn if nn else None, 1, '%')}) | Terminos del menu: {te}/{tn} mal ({f(100 * te / tn if tn else None, 1, '%')})")
    perdidos = sum(1 for t in turnos if t.get("sttMs") is None)
    multi = sum(1 for t in turnos if t.get("finales", 1) > 1)
    out.append(f"  Turnos sin final del STT (el agente no oyo nada): {perdidos} | turnos partidos en varios finales: {multi}")
    out.append(f"  Interrupciones (el motor corto al agente): {sum(r.get('interrupciones', 0) for r in filas)} | cliente hablo encima del agente: {sum(r.get('hablaEncimaDelAgente', 0) for r in filas)} | caidas del STT: {sum(len(r.get('sttCaidas', [])) for r in filas)}")
    peores = sorted([(t['wer']['s'] + t['wer']['d'] + t['wer']['i'], t) for t in turnos if t["wer"]["n"]], key=lambda x: -x[0])[:5]
    out.append("  Peores turnos (errores de palabra):")
    for e, t in peores:
        if e == 0: break
        out.append(f"    [{e}] dicho: {t['dicho'][:90]!r}\n        oido:  {t['oido'][:90]!r}")
    out.append("")
    ok = sum(1 for r in filas if r.get("veredicto") == "PASA")
    out.append(f"AGENTE: {ok}/{len(filas)} PASAN (juez + checks) | solo checks duros: {sum(1 for r in filas if r.get('soloHard') == 'PASA')}/{len(filas)}")
    fallas = [r for r in filas if r.get("veredicto") != "PASA"]
    for r in fallas[:15]: out.append(f"  FALLA {r['id']} [{r.get('causa')}] {str(r.get('motivo'))[:110]}")
    out.append("")
    stt_s = sum(r.get("audioSttS", 0) for r in filas); ch = sum(r.get("ttsCharsAgente", 0) for r in filas)
    # `dgAcumulado` es el total corrido de UN proceso: por archivo se toma el mayor y se suman los archivos.
    por_archivo = {}
    for r in filas:
        d = r.get("dgAcumulado", {})
        if d.get("usd", 0) >= por_archivo.get(r["_archivo"], {}).get("usd", -1): por_archivo[r["_archivo"]] = d
    ult = {k: sum(d.get(k, 0) for d in por_archivo.values()) for k in ("usd", "usdStt", "usdTts")}
    out.append(f"COSTO Deepgram (calculado: minutos x tarifa + caracteres x tarifa; la llave no lee la API de uso): acumulado de la corrida US${f(ult.get('usd'), 4)} (STT ${f(ult.get('usdStt'), 4)}, TTS agente+cliente ${f(ult.get('usdTts'), 4)})")
    out.append(f"  audio STT enviado {stt_s / 60:.1f} min | caracteres del agente al TTS {ch} | costo del motor (estimacion propia) US${sum(r.get('costoMotorDgUsd', 0) for r in filas):.4f} | LLM agente US${sum(r.get('llmUsd', 0) for r in filas):.3f}")
    print("\n".join(out))

main()
