(function(d,w){var r=d.documentElement,o,t,m,q,l;try{l=w.localStorage}catch{l=0}
q=new URLSearchParams(w.location.search).get("diseno");
try{if(q=="ds3")l.setItem("atiende-diseno",q);else if(q=="off")l.removeItem("atiende-diseno");else q=l.getItem("atiende-diseno")}catch{m=0}
if(q!="ds3")return;r.dataset.diseno=q;
try{t=l.getItem("atiende-tema");o=t=="oscuro"||(t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches)}catch{o=0}
r.classList.toggle("dark",!!o);m=d.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",o?"#0e0e10":"#ffffff")})(document,window);
