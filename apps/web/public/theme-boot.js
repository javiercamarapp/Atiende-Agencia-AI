(function(d,w){var r=d.documentElement,o,t,m,q,l;try{l=w.localStorage;t=l.getItem("atiende-tema")}catch(e){}
o=t=="oscuro"||(t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches);
r.classList.toggle("dark",!!o);m=d.querySelector('meta[name="theme-color"]');
m&&m.setAttribute("content",o?"#0e0e10":"#ffffff");
q=new URLSearchParams(w.location.search).get("diseno");
try{q=="ds3"?l.setItem("atiende-diseno",q):q=="off"?l.removeItem("atiende-diseno"):q=l.getItem("atiende-diseno")}catch(e){}
q=="ds3"&&(r.dataset.diseno=q)})(document,window);
