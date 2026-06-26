#!/usr/bin/env node
// Generátor data.json pro statický web — replikuje logiku top500llm.html v terminálu.
// Sestaví žebříček z Wikidat + Wikimedie, změří LLM panel přes OpenRouter, zapíše data.json.
//
// Spuštění:
//   OPENROUTER_API_KEY=sk-or-v1-...  node build-data.mjs
// nebo klíč v souboru .openrouter-key (jeden řádek, gitignored).
//
// Volitelné env: POOL=500  MEASURE=200  BORN_FROM=1935  CONC=4
//
// Odolnost proti pádu: rozměřené hlasy se průběžně ukládají do .llm-cache.json,
// stažený pool (data + čtenost) do .pool-cache.json. Při restartu se hotové přeskočí.
// Pro čerstvý běh smaž tyto dva soubory.

import fs from "node:fs";

const WDQS = "https://query.wikidata.org/sparql";
const PV = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/cs.wikipedia/all-access/all-agents/";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const UA = "ZnamostCechu/1.0 (statický web; kontakt: extracermak@gmail.com)";

// ── panel modelů (zrcadlí PANEL v top500llm.html) ──
const PANEL = [
  { model: "anthropic/claude-opus-4.8",     tier: "strop" },
  { model: "openai/gpt-5.5",                tier: "strop" },
  { model: "google/gemini-3.1-pro-preview", tier: "strop" },
  { model: "deepseek/deepseek-v4-flash",    tier: "střed" },
  { model: "openai/gpt-5.4-mini",           tier: "střed" },
  { model: "google/gemma-3-12b-it",         tier: "sklep" },
  { model: "mistralai/mistral-small-2603",  tier: "sklep" },
];
const TIER_W = { strop: 1, "střed": 2, sklep: 3.5 };
const CAP = 2; // strop koeficientu, když nezná žádný frontier

// váhy os a potlačení špiček (publikační default = slidery v top500llm.html)
const W = { g: 0.20, dur: 0.50, l: 0.30, pen: 0.30 };

const POOL = +process.env.POOL || 500;        // velikost poolu pro percentily
const MEASURE = +process.env.MEASURE || 200;   // kolik top osob měřit LLM (= velikost data.json)
const BORN_FROM = +process.env.BORN_FROM || 1935;
const CONC = +process.env.CONC || 4;           // souběžně měřených osob

const KEY = (process.env.OPENROUTER_API_KEY || readKeyFile() || "").trim();
function readKeyFile() { try { return fs.readFileSync(".openrouter-key", "utf8"); } catch { return ""; } }

const CACHE_LLM = ".llm-cache.json";
const CACHE_POOL = ".pool-cache.json";

const FIELDS = {
  politika:["politik","politič","ministr","preziden","senátor","poslan","diplomat","guvernér","politician","minister","president","senator","diplomat","governor","statesman"],
  sport:["sport","fotbal","hokej","tenis","atlet","lyžař","závodník","trenér","football","soccer","hockey","tennis","athlete","ski","player","coach","olympic","cyclist","boxer",
    "šach","chess","judo","judist","judoka","zápas","wrestl","snowboard","brusl","skater","skating","rychlobrusl","kanoist","canoe","kayak","veslař","rower","horolez","mountaineer","climb","lezec","biatlon","biathlon","gymnast","plav","swimmer","běžec","runner","oštěp","javelin","disk","discus","skok","jump","střelec","shooter","kulturist","motocykl","racer","pilot","jezdec","rider"],
  hudba:["hudb","zpěv","skladatel","kytar","klavír","dirigent","raper","music","singer","composer","guitar","pianist","rapper","conductor","songwriter","violinist","cellist","houslist","kontrabas","double-bass","jazz","opern","opera"],
  film:["herec","hereč","režisér","moderátor","komik","bavič","film","televiz","divadel","actor","actress","director","filmmaker","presenter","comedian","screenwriter","producer","theatre",
    "taneč","tanec","balet","choreograf","dancer","ballet","choreographer"],
  veda:["věd","fyzik","chemik","biolog","matematik","historik","filozof","ekonom","lékař","profesor","sociolog","psycholog","právník","scien","physic","chemist","biolog","mathematic","historian","philosoph","econom","professor","researcher","academic","physician","lawyer",
    "archeolog","archaeolog","egyptolog","egyptolog","antropolog","anthropolog","astronom","geolog","genetik","genetic","neurolog","lingvist","linguist","botanik","zoolog","paleontolog","epigraf","epigraph","teolog","theolog"],
  literatura:["spisovatel","básník","prozaik","dramatik","esejist","překladatel","writer","author","novelist","poet","playwright","essayist","translator"],
  zurnalistika:["novinář","publicist","redaktor","reportér","komentátor","journalist","reporter","columnist","editor","blogger","youtuber","podcaster"],
  byznys:["podnikatel","manažer","ředitel","investor","entrepreneur","businessman","businessperson","manager","ceo","investor","founder"],
  umeni:["malíř","sochař","výtvarník","fotograf","architekt","designér","painter","sculptor","architect","photographer","designer","artist","illustrator"],
  moda:["model","modelka","modeling","fashion model","supermodel","topmodel","miss","beauty pageant","kráska"],
  nabozenstvi:["biskup","arcibiskup","kněz","farář","kardinál","bishop","archbishop","priest","cardinal","clergy","rabín","rabbi","duchovní","kazatel","preacher"],
};
function fieldsOf(t) { t = (t || "").toLowerCase(); const o = new Set();
  for (const f in FIELDS) for (const k of FIELDS[f]) if (t.includes(k)) { o.add(f); break; }
  return o; }

// ── HTTP helpery s retry na transientní chyby ──
async function fetchRetry(url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) { last = new Error("HTTP " + r.status); await sleep(1500 * (i + 1)); continue; }
      return r;
    } catch (e) { last = e; await sleep(1000 * (i + 1)); }
  }
  throw last;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sparql(query) {
  const r = await fetchRetry(WDQS + "?format=json&query=" + encodeURIComponent(query), { headers: { "User-Agent": UA, "Accept": "application/sparql-results+json" } });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  return (await r.json()).results.bindings;
}
const poolQuery = (from, limit) => `
SELECT ?person ?linkcount ?idcount ?stcount ?birth ?article WHERE {
  ?person wdt:P31 wd:Q5 ; wdt:P27 wd:Q213 ;
          wikibase:sitelinks ?linkcount ; wikibase:identifiers ?idcount ; wikibase:statements ?stcount ;
          wdt:P569 ?bd .
  FILTER NOT EXISTS { ?person wdt:P570 [] }
  BIND(YEAR(?bd) AS ?birth) FILTER(?birth >= ${from})
  ?article schema:about ?person ; schema:isPartOf <https://cs.wikipedia.org/> .
} ORDER BY DESC(?linkcount) LIMIT ${limit}`;
const decorateQuery = ids => `
SELECT ?person ?personLabel ?personDescription
  (GROUP_CONCAT(DISTINCT ?occEnL;separator=" | ") AS ?occsEn)
  (GROUP_CONCAT(DISTINCT ?occCsL;separator=" | ") AS ?occsCs) WHERE {
  VALUES ?person { ${ids.map(q => "wd:" + q).join(" ")} }
  OPTIONAL { ?person wdt:P106 ?o. ?o rdfs:label ?occEnL. FILTER(LANG(?occEnL)="en") }
  OPTIONAL { ?person wdt:P106 ?o2. ?o2 rdfs:label ?occCsL. FILTER(LANG(?occCsL)="cs") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "cs,en". }
} GROUP BY ?person ?personLabel ?personDescription`;

function pvRange() {
  const n = new Date();
  const e = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  const s = new Date(Date.UTC(e.getUTCFullYear() - 2, e.getUTCMonth(), 1));
  const f = d => d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + "01";
  return [f(s), f(e)];
}
async function fetchPV(title, from, to) {
  try {
    const r = await fetchRetry(PV + encodeURIComponent(title) + "/monthly/" + from + "/" + to, { headers: { "User-Agent": UA } });
    if (!r.ok) return { median: 0, peak: 0 };
    const v = ((await r.json()).items || []).map(it => it.views || 0);
    if (!v.length) return { median: 0, peak: 0 };
    const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return { median: s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2), peak: Math.max(...v) };
  } catch { return { median: 0, peak: 0 }; }
}

async function poolRun(items, worker, onTick, conc) {
  let i = 0, done = 0; const N = items.length;
  async function nx() { while (i < N) { const k = i++; await worker(items[k]); onTick && onTick(++done, N); } }
  await Promise.all(Array.from({ length: Math.min(conc || 12, N) }, nx));
}

// ── composite (0–1000) ──
function pctRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(vals.length), n = vals.length;
  for (let k = 0; k < n; k++) r[idx[k][1]] = n > 1 ? k / (n - 1) : 1;
  return r;
}
function recompute(DATA) {
  const pG = pctRanks(DATA.map(p => Math.log10(p.sitelinks + 1)));
  const pID = pctRanks(DATA.map(p => Math.log10(p.idcount + 1)));
  const pST = pctRanks(DATA.map(p => Math.log10(p.stcount + 1)));
  const pL = pctRanks(DATA.map(p => Math.log10(p.pvMedian + 1)));
  const pSP = pctRanks(DATA.map(p => Math.log10(Math.max(1, p.spike))));
  DATA.forEach((p, i) => {
    p.pG = pG[i]; p.pDur = 0.75 * pID[i] + 0.25 * pST[i]; p.pL = pL[i]; p.spk = pSP[i];
    const f = 1 - W.pen * p.spk;
    p.gPart = W.g * p.pG * f; p.durPart = W.dur * p.pDur * f; p.lPart = W.l * p.pL * f;
    p.composite = Math.round((p.gPart + p.durPart + p.lPart) * 1000);
  });
  DATA.sort((a, b) => b.composite - a.composite);
  DATA.forEach((p, i) => p.rank = i + 1);
}

// ── LLM ──
function buildPrompt(p) {
  const b = p.birth ? ` (born ${p.birth})` : "";
  return `Identify this specific person using only your own training knowledge. Do not guess or invent.
Person: ${p.name}${b}
If you are not reasonably confident who this is, reply with exactly: UNKNOWN
Otherwise reply in exactly these three lines and nothing else:
PROFESSION: <their main profession or field>
NATIONALITY: <their nationality>
KNOWN FOR: <one notable work, role, or achievement>`;
}
async function askModel(model, prompt) {
  const r = await fetchRetry(OPENROUTER, {
    method: "POST",
    headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("HTTP " + r.status + (t ? " " + t.slice(0, 70) : "")); }
  return (await r.json()).choices?.[0]?.message?.content || "";
}
function verify(text, p) {
  const raw = (text || "").trim();
  if (!raw || /^\W*unknown\W*$/i.test(raw)) return 0;
  const prof = (raw.match(/PROFESSION:\s*(.+)/i) || [])[1] || "";
  const nat = (raw.match(/NATIONALITY:\s*(.+)/i) || [])[1] || "";
  if (!prof && /unknown/i.test(raw)) return 0;
  const said = fieldsOf(prof || raw), truth = fieldsOf(p.occ); let pm = false;
  for (const f of said) if (truth.has(f)) { pm = true; break; }
  const nm = /czech|česk|bohemia/i.test(nat || raw);
  return pm ? (nm ? 2 : 1) : 0;
}
async function scoreLLM(p, cache) {
  // Cache ukládá celou odpověď modelu (ne jen recog) — díky tomu je re-verifikace
  // po úpravě FIELDS zdarma; stačí přegenerovat bez nového volání modelů.
  const prompt = buildPrompt(p);
  const res = await Promise.all(PANEL.map(async m => {
    const ck = p.qid + "|" + m.model;
    let text;
    if (typeof cache[ck] === "string") text = cache[ck];
    else {
      try { text = await askModel(m.model, prompt); cache[ck] = text; }
      catch { return { ...m, recog: 0, available: false }; }
    }
    return { ...m, recog: verify(text, p), available: true };
  }));
  const av = res.filter(r => r.available); let num = 0, den = 0;
  for (const r of av) { const w = TIER_W[r.tier] || 1; num += w * (r.recog / 2); den += w; }
  let coef = den ? Math.round(10 * num / den) : 0;
  const hasTop = av.some(r => r.tier === "strop"), topR = av.filter(r => r.tier === "strop").reduce((s, r) => s + r.recog, 0);
  if (hasTop && topR === 0 && coef > CAP) coef = CAP;
  return { coef, models: res.map(m => ({ model: m.model, tier: m.tier, recog: m.recog, available: m.available })) };
}

// ── build pool (data + čtenost) s cache ──
async function buildPool() {
  if (fs.existsSync(CACHE_POOL)) {
    console.log("Načítám pool z " + CACHE_POOL + " (smaž ho pro čerstvá data).");
    return JSON.parse(fs.readFileSync(CACHE_POOL, "utf8"));
  }
  console.log(`Dotazuji Wikidata (pool ${POOL}, narození od ${BORN_FROM})…`);
  const rows = await sparql(poolQuery(BORN_FROM, POOL));
  let people = rows.map(b => {
    const title = decodeURIComponent(b.article.value.split("/wiki/").pop());
    return { qid: b.person.value.split("/").pop(), title, name: title.replace(/_/g, " "), desc: "", occ: "",
      sitelinks: +b.linkcount.value, idcount: +(b.idcount?.value || 0), stcount: +(b.stcount?.value || 0),
      birth: b.birth ? +b.birth.value : null, pvMedian: 0, pvPeak: 0, spike: 1 };
  });
  console.log(`  ${people.length} osob. Stahuji jména a profese…`);
  const m = {}; people.forEach(p => m[p.qid] = p);
  for (let i = 0; i < people.length; i += 150) {
    const g = people.slice(i, i + 150);
    try {
      const bind = await sparql(decorateQuery(g.map(p => p.qid)));
      bind.forEach(b => { const p = m[b.person.value.split("/").pop()]; if (!p) return;
        // label service vrací QID, když entita nemá cs/en popisek — pak nech jméno z článku
        if (b.personLabel?.value && !/^Q\d+$/.test(b.personLabel.value)) p.name = b.personLabel.value;
        p.desc = b.personDescription?.value || "";
        p.occ = [(b.occsEn?.value || ""), (b.occsCs?.value || "")].join(" | "); });
    } catch (e) { console.log("  (dekorace dávky selhala, pokračuji)"); }
  }
  const [f2, t2] = pvRange();
  console.log(`  Stahuji čtenost cs.wiki (${f2}–${t2})…`);
  let done = 0;
  await poolRun(people, async p => { const x = await fetchPV(p.title, f2, t2); p.pvMedian = x.median; p.pvPeak = x.peak; p.spike = (x.peak + 1) / (x.median + 1); },
    d => { if (d % 50 === 0 || d === people.length) process.stdout.write(`\r  čtenost ${d}/${people.length}`); }, 12);
  process.stdout.write("\n");
  fs.writeFileSync(CACHE_POOL, JSON.stringify(people));
  return people;
}

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_LLM, "utf8")); } catch { return {}; } }
function saveCache(c) { fs.writeFileSync(CACHE_LLM, JSON.stringify(c)); }

async function main() {
  if (!KEY) { console.error("Chybí OPENROUTER_API_KEY (env nebo soubor .openrouter-key)."); process.exit(1); }

  let people = await buildPool();
  recompute(people);                       // composite + parts na celém poolu
  const targets = people.slice(0, MEASURE); // top N podle pořadí
  console.log(`\nMěřím LLM panel pro top ${targets.length} osob (${PANEL.length} modelů = ${targets.length * PANEL.length} dotazů).`);

  const cache = loadCache();
  const t0 = Date.now(); let done = 0;
  await poolRun(targets, async p => {
    p.llm = await scoreLLM(p, cache);
    saveCache(cache); // průběžně — odolnost proti pádu
  }, (d, n) => { done = d; const el = (Date.now() - t0) / 1000, eta = d ? Math.round(el / d * (n - d)) : 0;
      process.stdout.write(`\r  měřím ${d}/${n} osob · ~${eta}s zbývá   `); }, CONC);
  process.stdout.write("\n");

  const d = new Date();
  const generated = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  const out = {
    generated, count: targets.length,
    panel: PANEL.map(m => ({ model: m.model, tier: m.tier })),
    people: targets.map(p => ({
      rank: p.rank, name: p.name, qid: p.qid, birth: p.birth, desc: p.desc || "", title: p.title,
      sitelinks: p.sitelinks, composite: p.composite,
      parts: { g: +p.gPart.toFixed(4), dur: +p.durPart.toFixed(4), l: +p.lPart.toFixed(4) },
      llm: p.llm ? { coef: p.llm.coef, models: p.llm.models } : null,
    })),
  };
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/data.json", JSON.stringify(out, null, 2));
  const measured = out.people.filter(p => p.llm).length;
  console.log(`\nHotovo. Zapsáno data.json — ${out.count} osob, LLM změřeno ${measured}.`);
}

main().catch(e => { console.error("\nChyba:", e.message || e); process.exit(1); });
