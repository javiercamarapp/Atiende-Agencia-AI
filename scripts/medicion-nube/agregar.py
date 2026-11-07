#!/usr/bin/env python3
"""Agrega los artefactos de las repeticiones (una carpeta por rep con log.txt, convos-*.json, telemetria-turnos.jsonl,
flag.txt, RESUMEN.txt, marcas CORTADA/INVALIDA/NO-CORRIO) y escribe un resumen en Markdown (pensado para $GITHUB_STEP_SUMMARY).
Solo lectura de archivos; sin red ni llaves. Uso: agregar.py <dir-con-carpetas-de-reps> [salida.md]"""
import glob, json, os, re, sys

def stats(xs):  # misma definicion que lib.ts (stats)
    a = sorted(xs)
    if not a: return dict(n=0, med=0, p95=0, max=0)
    q = lambda p: a[min(len(a) - 1, int(p * len(a)))]
    return dict(n=len(a), med=q(.5), p95=q(.95), max=a[-1])

def leer(p, d=""):
    try: return open(p, encoding="utf-8", errors="replace").read()
    except OSError: return d

def rep_de(carpeta):
    m = re.search(r"rep(\d+)", os.path.basename(carpeta)); return int(m.group(1)) if m else 0

def analiza(c):
    r = dict(rep=rep_de(c), dir=os.path.basename(c))
    r["no_corrio"] = leer(f"{c}/NO-CORRIO").strip()
    r["cortada"] = os.path.exists(f"{c}/CORTADA")
    r["invalida"] = leer(f"{c}/INVALIDA").strip()
    r["flag"] = leer(f"{c}/flag.txt").strip()
    ev = []
    fs = glob.glob(f"{c}/convos-*.json")
    if fs:
        try: ev = json.load(open(fs[0], encoding="utf-8"))
        except Exception: ev = []
    med = [e for e in ev if not e.get("pendiente") and not e.get("excluido")]
    r["total"] = len(med); r["pasan"] = sum(1 for e in med if e.get("veredicto") == "PASA")
    r["fallan"] = [e["id"] for e in med if e.get("veredicto") != "PASA"]
    ff, prov = [], []
    for e in med:
        blob = json.dumps([e.get("hard"), e.get("transcript")], ensure_ascii=False)
        if "fetch failed" in blob: ff.append(e["id"])
        if any(t.get("proveedor") for t in (e.get("transcript") or []) if isinstance(t, dict)): prov.append(e["id"])
    r["inv_fetch"] = sorted(set(ff)); r["inv_prov"] = sorted(set(prov))
    inval = set(ff) | set(prov)
    r["pasan_sin_inv"] = sum(1 for e in med if e.get("veredicto") == "PASA")
    r["total_sin_inv"] = sum(1 for e in med if e["id"] not in inval)
    ms = [m for e in med for m in (e.get("ms") or [])]
    r["lat"] = stats(ms)
    tel = []
    for l in leer(f"{c}/telemetria-turnos.jsonl").splitlines():
        try: t = json.loads(l)
        except Exception: continue
        if t.get("evento") == "whatsapp_turno": tel.append(t)
    r["turnos_tel"] = len(tel)
    r["tel_prov"] = sum(1 for t in tel if t.get("resultado") in ("error_proveedor", "presupuesto_agotado"))
    r["tel_p95"] = stats([t["latenciaTotalMs"] for t in tel if isinstance(t.get("latenciaTotalMs"), (int, float))])["p95"]
    u0, u1 = leer(f"{c}/uso-inicial.txt").strip(), leer(f"{c}/uso-final.txt").strip()
    try: r["delta"] = round(float(u1) - float(u0), 4)
    except ValueError: r["delta"] = None
    m = re.search(r"fetch_failed=(\d+)", leer(f"{c}/RESUMEN.txt")); r["fetch_failed"] = int(m.group(1)) if m else None
    return r

def main():
    base = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else None
    reps = sorted((analiza(c) for c in glob.glob(f"{base}/*") if os.path.isdir(c)), key=lambda x: x["rep"])
    L = ["## Medicion del agente: resumen por repeticion", ""]
    if not reps: L.append("Sin artefactos de repeticiones."); 
    else:
        L += ["| rep | pasan | sin invalidas | p95 turno (ms) | p95 telemetria (ms) | turnos | fetch_failed | error_proveedor (tel.) | esc. inv. fetch | esc. inv. proveedor | USD | estado |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in reps:
            est = r["no_corrio"] or ("CORTADA por tope de gasto" if r["cortada"] else "") 
            if r["invalida"]: est = (est + "; " if est else "") + r["invalida"]
            est = est or "ok"
            L.append(f"| {r['rep']} | {r['pasan']}/{r['total']} | {r['pasan_sin_inv']}/{r['total_sin_inv']} | {r['lat']['p95']} | {r['tel_p95']} | {r['turnos_tel']} | {r['fetch_failed'] if r['fetch_failed'] is not None else '?'} | {r['tel_prov']} | {len(r['inv_fetch'])} | {len(r['inv_prov'])} | {r['delta'] if r['delta'] is not None else '?'} | {est} |")
        ok = [r for r in reps if r["total"] and not r["invalida"] and not r["cortada"]]
        L.append("")
        if ok:
            L.append(f"Reps validas (sin INVALIDA ni CORTADA): {len(ok)}/{len(reps)} ; pasan/rep = {', '.join(str(r['pasan']) for r in ok)} ; media = {sum(r['pasan'] for r in ok)/len(ok):.2f}")
        else: L.append("Ninguna repeticion valida.")
        gasto = sum(r["delta"] or 0 for r in reps)
        L.append(f"\nGasto sumado de los deltas por job: USD {gasto:.3f} (el uso de la llave es global: en paralelo cada delta incluye a las demas reps, por lo que la suma sobrestima).")
        L.append("\n### Escenarios que fallan por rep"); 
        for r in reps: L.append(f"- rep {r['rep']}: {', '.join(r['fallan']) or 'ninguno'}")
        L.append("\n### Invalidas por escenario")
        for r in reps: L.append(f"- rep {r['rep']}: fetch_failed={', '.join(r['inv_fetch']) or '-'} ; error_proveedor={', '.join(r['inv_prov']) or '-'}")
        L.append("\n### Condicion"); 
        for r in reps[:1]: L.append("```\n" + re.sub(r"sha=\S+", lambda m: m.group(0), r["flag"]) + "\n```")
    txt = "\n".join(L) + "\n"
    if out: open(out, "w", encoding="utf-8").write(txt)
    print(txt)
main()
