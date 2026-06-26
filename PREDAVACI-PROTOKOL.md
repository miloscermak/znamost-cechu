# Předávací protokol — Projekt „Ve vahách / Známost Čechů"

Tento dokument shrnuje **metodiku, vzorce, konstanty a klíčová rozhodnutí** ze stavby čtyř nástrojů, aby v nich šlo pokračovat bez znalosti původní konverzace. Doplňuje `CLAUDE.md` (orientační přehled).

---

## 1. Záměr projektu

Měřit „slávu / známost" osobností dvěma nezávislými způsoby a srovnávat je:

1. **Z dat** — encyklopedická a čtenářská stopa (Wikidata + Wikimedia).
2. **Z modelů** — jak hluboko je jméno zakódované ve vahách LLM (bez webu).

Nejcennější výstup není ani jeden koeficient sám o sobě, ale **jejich rozdíl**: „koho zná Wikipedie, ale ne AI, a naopak." To je i smysluplná hypotéza — modely se učí z trvalého psaného korpusu, takže by jejich znalost měla korelovat spíš s trvalou stopou než s momentální čteností.

---

## 2. Datové zdroje a endpointy

- **Wikidata SPARQL:** `https://query.wikidata.org/sparql?format=json&query=…` — prostý GET, žádné vlastní hlavičky.
- **Wikidata entity search:** `https://www.wikidata.org/w/api.php?action=wbsearchentities&...&origin=*` (origin=* kvůli CORS).
- **Wikimedia pageviews:** `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}.wikipedia/all-access/all-agents/{title}/monthly/{from}/{to}` (datum `YYYYMMDD`, den vždy `01`).
- **OpenRouter:** `https://openrouter.ai/api/v1/chat/completions` (OpenAI-kompatibilní).

---

## 3. Datový koeficient (0–1000)

Používá ho `ve-vahach-seed.html` a `top500llm.html`. Tři osy:

- **Globální** = `wikibase:sitelinks` (počet jazykových verzí Wikipedie).
- **Trvalá** = `wikibase:identifiers` (autoritní ID: VIAF, GND, ISNI, ORCID, knihovní/oborové katalogy, IMDb…) jako primární signál + `wikibase:statements` jako doplněk. Tyto záznamy přiděluje instituce, ne dav → odolné vůči skandálu.
- **Živá** = **medián** měsíční čtenosti cs.wikipedia za **24 měsíců** (ne součet — medián ignoruje jednorázové špičky).

### Vzorec

Pro každou osu napříč poolem:

```
x'        = log10(value + 1)
pct       = percentilní pořadí x' v poolu  ∈ [0,1]   (rank/(n-1))
pDur      = 0.75 * pct(identifiers) + 0.25 * pct(statements)
spike     = (peak + 1) / (median + 1)          // pro živou osu
spikiness = percentil log10(spike) v poolu
factor    = 1 - penalty * spikiness            // potlačení nárazové slávy
composite = round( 1000 * (wG*pG + wDur*pDur + wL*pL) * factor )
```

- Výchozí váhy: **wG = 0.20, wDur = 0.50, wL = 0.30** (normalizované ze sliderů). Snížená globální osa kvůli zkreslení sitelinků ve prospěch sportovců (mezinárodní kariéra → cizojazyčné pahýly) na úkor domácích herců/spisovatelů/novinářů.
- Výchozí `penalty` (potlačení špiček): **0.30**.
- Vlajka ⚡ když `spike >= 4` (špička ≥ 4× medián).
- **Pozor:** percentil je relativní vůči poolu, takže composite **závisí na složení poolu** (není absolutně kalibrovaný). Pro žebříček (řazení) to nevadí.

### Poolový dotaz (žijící Češi)

```sparql
SELECT ?person ?linkcount ?idcount ?stcount ?birth ?article WHERE {
  ?person wdt:P31 wd:Q5 ; wdt:P27 wd:Q213 ;
          wikibase:sitelinks ?linkcount ; wikibase:identifiers ?idcount ;
          wikibase:statements ?stcount ; wdt:P569 ?bd .
  FILTER NOT EXISTS { ?person wdt:P570 [] }     # žijící = bez data úmrtí
  BIND(YEAR(?bd) AS ?birth) FILTER(?birth >= 1935)   # ořez „nesmrtelných" bez data úmrtí
  ?article schema:about ?person ; schema:isPartOf <https://cs.wikipedia.org/> .
} ORDER BY DESC(?linkcount) LIMIT {N}
```

Jména/profese se dotahují **zvlášť** „dekoračním" dotazem přes `VALUES` po dávkách ~150 (label service nad celou populací způsobuje timeout/500).

---

## 4. LLM koeficient (0–10)

Používá ho `llmfight.html` a `top500llm.html`.

### Princip a prompt

- **Disambiguace neutrálním faktem:** do promptu jde `(born {rok})`. Rok jednoznačně určí nositele, ale **neprozradí to, co se hodnotí** (profese, národnost). Nikdy do promptu nedávat profesi/dílo.
- Prompt (anglicky, modely mají lepší recall v EN; ground truth z Wikidat je taky EN):

```
Identify this specific person using only your own training knowledge. Do not guess or invent.
Person: {jméno} (born {rok})
If you are not reasonably confident who this is, reply with exactly: UNKNOWN
Otherwise reply in exactly these three lines and nothing else:
PROFESSION: <...>
NATIONALITY: <...>
KNOWN FOR: <...>
```

- `temperature: 0`, `max_tokens: 300` (reasoning modely jinak vrátí prázdno).

### Auto-verifikace → rozpoznání 0/1/2

Bez drahého soudce; porovnává se s ground truth z Wikidat:

- **2** = sedí profese **i** národnost.
- **1** = sedí jen profese.
- **0** = `UNKNOWN`, nebo profese nesedí (= konfabulace).

- **profMatch:** dvojjazyčná mapa oborů (`FIELDS`: politika, sport, hudba, film, věda, literatura, žurnalistika, byznys, umění). Odpověď i Wikidata profese se převedou na množinu oborů; shoda = neprázdný průnik. (Tolerantní vůči „writer ↔ spisovatel ↔ novelist".)
- **natMatch:** v `top500llm` (celý pool jsou čeští občané) stačí `/czech|česk|bohemia/i`. V `llmfight` (libovolná národnost) se porovnává s názvem země + demonymem (`P1549`) z Wikidat.

### Vzorec skóre

```
recog ∈ {0,1,2} per model
váhy:  TIER_W = { strop:1, střed:2, sklep:3.5 }    // malé modely váží víc
num   = Σ ( váha * recog/2 )   přes DOSTUPNÉ modely
den   = Σ ( váha )             přes DOSTUPNÉ modely
coef  = round( 10 * num / den )                    // 0–10, celé číslo
```

- **Frontier pojistka:** pokud nezná **žádný** model patra `strop` (a aspoň jeden strop je dostupný), `coef` se zastropuje na **CAP = 2**. Důvod: „znalost" malého modelu bez potvrzení velkým je nejspíš náhodná trefa přes jméno. Malý model umí skóre jen *potvrdit*, ne *vyrobit*.
- **Cache** podle `qid|model`.
- **Verdikt (llmfight):** shodný coef → „Nerozhodně"; rozdíl 1 → „(těsně)"; jinak vítěz.

### Proč 0–10 a ne 0–1000

U 7 modelů a 3 úrovní rozpoznání je trojmístné číslo falešná přesnost; malé modely navíc kolísají (jednou jméno „najdou", podruhé ne). Hrubá celočíselná škála je poctivější. (Dříve bylo 0–1000 s prahem nerozhodna 60 bodů — zrušeno.)

---

## 5. Absolutní varianta pro souboj (`wikifight.html`)

Souboj dvou lidí nejde percentilovat, takže se používá **absolutní** datové skóre (log vs. pevný strop):

```
axisScore(v, ref) = min( 1, log10(v+1) / log10(ref+1) )
REF = { sitelinks:250, ids:60, statements:600, pv:300000 }
nG   = axisScore(sitelinks, 250)
nDur = 0.75*axisScore(ids,60) + 0.25*axisScore(statements,600)
nL   = axisScore(pv_cs_median + pv_en_median, 300000)   // cs+en kvůli férovosti
score = round( 1000 * (0.20*nG + 0.50*nDur + 0.30*nL) )
```

- Čtenost = součet mediánů cs + en (mezinárodní souboj by jinak znevýhodnil cizince).
- Referenční stropy jsou nastřelené od oka — pro *porovnání* nevadí (obě osoby stejnou funkcí), kalibraci ber s rezervou.
- Funguje pro kohokoli (živé i historické), resolver přes `wbsearchentities` + disambiguace popiskem.

---

## 6. Panel modelů (LLM nástroje)

Volba je **naše, v podstatě intuitivní** — princip je *schodiště velikostí*, ne „nejlepší modely". Barvy koleček: velké = modrá, střední = zelená, malé = červená.

| Patro | Váha | Barva | Modely (slug) |
|---|---|---|---|
| strop | 1 | modrá | `anthropic/claude-opus-4.8`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview` |
| střed | 2 | zelená | `deepseek/deepseek-v4-flash`, `openai/gpt-5.4-mini` |
| sklep | 3.5 | červená | `google/gemma-3-12b-it`, `mistralai/mistral-small-2603` |

- Frontier trojka byla ověřena na OpenRouteru; ostatní jsou nejlepší odhad k době stavby (cca červen 2026).
- **Slugy se mění** — jsou v editovatelném bloku `PANEL`. Neplatný slug = tečkované kolečko / přeškrtnutý model, nespadne to.
- Záměr: různí tvůrci (Anthropic, OpenAI, Google, DeepSeek, Mistral) = různé tréninkové korpusy → rozptyl mezi nimi je sám o sobě signál (např. evropský Mistral zná českou osobnost, kterou americké modely minou).

---

## 7. Kategorie (jen `ve-vahach-seed.html`)

`top500llm.html` kategorie **nemá** (záměrně vypuštěny — jsou nepřesné a ranking na nich nestojí).

V seedu fungují takto:
- **Seeding po kategoriích:** každý obor se hledá zvlášť dotazem na profese (`P106`) + podtypy přes `P279*`. Tím i domácí obory (žurnalistika, byznys) čerpají z celé své populace, ne ze zbytků globálního žebříčku.
- **Priorita při více profesích** (první nárokuje): Politika → Sport → Věda → Hudba → Film/TV/divadlo → **Žurnalistika a sociální média** → Literatura → Výtvarné umění a design → Byznys. (Žurnalistika je schválně nízko, aby nesbírala baviče/moderátory.)
- **„Ostatní"** = doplnění globálním poolem (kdo se nevešel do oborů).
- **Kategorie jsou filtr/lupa, ne kvóta.** Hlavní žebříček = poctivý top podle composite. Klik na obor → ten obor seřazený, pořadí v rámci oboru. Špatně zařazený člověk je tak jen řádek ve filtru, ne deformace žebříčku.
- Profesní QID kořeny jsou v bloku `CAT_SEED` (politik Q82955, sportovec Q2066131, vědec Q901, novinář Q1930187 atd.).
- **Známé omezení:** diskrétní zaškatulkování mnohostranně slavných lidí z neuspořádaných `P106` nálepek nikdy nebude čisté — to je povaha dat. Proto je obor jen filtr.

---

## 8. Klíčová rozhodnutí a jejich důvody

| Rozhodnutí | Důvod |
|---|---|
| Seed z Wikidat, ne z LLM | Jinak měříš jen to, koho LLM už zná → kruh. |
| Tři osy (přidána trvalá) | Pageviews měří *pozornost* (skandál, novost), ne slávu. Autoritní záznamy jsou odolné. |
| Medián 24 měs. + spike-index | Tlumí jednorázové špičky („kdo zakopl na pódiu"). |
| Kvóty 50/obor → zrušeny | Rovné kvóty fungují jen u čistých kategorií; ty čisté nejsou. Kategorie se staly filtrem, pak vypuštěny. |
| LLM koeficient 0–10 | Vyhýbá se falešné přesnosti; absorbuje kolísání malých modelů. |
| Konfabulace = 0 (ne pod UNKNOWN) | Auto-verifikace neumí spolehlivě odlišit konfabulaci od vlastní slepoty; trestat tip = odměňovat mlčení. |
| Škála rozpoznání 0–2 (ne 0–3) | Úroveň „klíčové dílo" auto-verifikace strojově nezvládá; přidá se až se soudcem. |
| Frontier pojistka | Malý model smí skóre jen potvrdit, ne vyrobit (ochrana proti náhodné trefě přes jméno). |

---

## 9. Technické lekce a pasti

- **Běh lokálně v prohlížeči**, ne v náhledu (ten blokuje fetch). Všechna API mají CORS.
- **SPARQL:** nikdy nepoužít název vázané proměnné jako alias `GROUP_CONCAT(... AS ?x)` → HTTP 500. Poolový dotaz štíhlý (label service nad celou populací = timeout). Dekorace zvlášť přes `VALUES` po ~150.
- **Pageviews:** měsíční endpoint vrací celý rozsah v jednom requestu → 24 měsíců = 1 volání na osobu (ne 24).
- **OpenRouter:** jen hlavičky `Authorization` + `Content-Type` (minimalizace CORS preflightu); `max_tokens` velkoryse (reasoning modely jinak vrátí prázdno); chyby se diagnostikují podle stavu (401 = klíč/kredit, 4xx = slug, „Failed to fetch" = síť/náhled).
- **Žádné localStorage** (zakázáno v daném prostředí) — klíč i stav jen v paměti.
- **Náklady:** LLM měření top N × 7 modelů = placené dotazy; 500 × 7 = 3 500 dotazů. Proto v `top500llm` měření na vyžádání po dávkách, default top 50, s cache.

---

## 10. Otevřené otázky / další kroky

- **Veřejné nasazení:** OpenRouter klíč nesmí být v prohlížeči → backend-proxy. Data předpočítat a cachovat, servírovat staticky kvůli náporu. (Soukromí: nástroje pracují jen s veřejnými osobnostmi, žádný veřejný vstup jmen — to je výhoda oproti otevřeným klonům.)
- **Pomluvy:** modely halucinují; u reálných jmenovaných lidí nezobrazovat poškozující/„trestněprávní" tvrzení. (Relevantní zejména pro budoucí veřejnou verzi a pro volnotextové „KNOWN FOR".)
- **Mřížka model × osobnost** (plná vizualizace) — odloženo.
- **Soudce-model** místo auto-verifikace — přesnější u „klíčového díla", umožní vrátit škálu 0–3; o jeden levný model navíc na osobu.
- **Ruční doplnění** online-native lidí (influenceři bez/ s tenkým článkem na Wikipedii).
- **Kalibrace** referenčních stropů ve `wikifight` a vah pater v LLM koeficientu — zatím nastřeleno.

---

## 11. Inventář souborů

- `ve-vahach-seed.html` — žebříček z dat, obory jako filtr.
- `wikifight.html` — souboj podle dat (absolutní skóre).
- `llmfight.html` — souboj podle znalosti modely.
- `top500llm.html` — žebříček z dat + LLM koeficient (finální nástroj).
- `CLAUDE.md` — orientační přehled.
- `PREDAVACI-PROTOKOL.md` — tento dokument.
