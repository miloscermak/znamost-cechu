# CLAUDE.md — Projekt „Ve vahách / Známost Čechů"

Sada samostatných HTML nástrojů, které měří **známost osobností** dvěma nezávislými způsoby: z otevřených dat (Wikidata + Wikimedia) a ze znalosti jazykových modelů (panel přes OpenRouter). Každý nástroj je jeden soubor `.html` bez build-kroku a bez backendu — čistý HTML/CSS/vanilla JS, data se tahají živě z veřejných API přímo v prohlížeči.

## Aplikace

| Soubor | Co dělá | Metrika | Stav |
|---|---|---|---|
| `ve-vahach-seed.html` | Žebříček ~500 žijících Čechů z Wikidat; obory jako filtr | datový koeficient 0–1000 | hotovo |
| `wikifight.html` | Souboj 2 osobností podle dat (i mezinárodní) | absolutní skóre 0–1000 | hotovo |
| `llmfight.html` | Souboj 2 osobností podle znalosti modely | LLM koeficient 0–10 | hotovo |
| `top500llm.html` | Žebříček z dat (bez kategorií) + doplnění LLM koeficientu + export JSON | obojí: 0–1000 a 0–10 | hotovo |
| `build-data.mjs` | CLI generátor `public/data.json` (Node, bez závislostí, odolný proti pádu) | obojí | hotovo |
| `public/index.html` + `public/data.json` | **Veřejný statický web** — top 200, nevolá AI, jen zobrazuje předpočítaná data; hlavní úhel = rozdíl wiki↔AI | obojí + rozdíl | hotovo |

`top500llm.html` je finální **měřící** nástroj (spojuje žebříček a LLM měření). Web ve `public/` je
**publikační**: data se přepočítají jednou před publikací (`build-data.mjs`, nebo ručně export
z `top500llm.html`), web sám už nic neměří. Nasazení přes Netlify (publish = `public/`). Detaily
a workflow přepočtu v `PREDAVACI-PROTOKOL.md` (sekce 11).

## Jak spustit

Stáhnout soubor a **otevřít v prohlížeči (Chrome) lokálně** (`file://` stačí). Náhled v editoru/canvasu blokuje externí volání — appky musí běžet jako skutečná stránka. Všechna použitá API (Wikidata SPARQL, Wikimedia pageviews, wbsearchentities, OpenRouter) posílají CORS hlavičky, takže z lokálního souboru fungují.

LLM nástroje (`llmfight`, `top500llm`) vyžadují **OpenRouter API klíč** (openrouter.ai/keys). Klíč zůstává jen v paměti stránky, neukládá se. Měření modely jsou **placené dotazy**.

## Dva koeficienty (stručně)

- **Datový koeficient 0–1000** — doložená známost ze tří os: *globální* (jazyky Wikipedie), *trvalá* (autoritní záznamy + počet tvrzení), *živá* (medián čtenosti cs.wiki za 24 měsíců). Log → percentil v rámci poolu → vážený průměr (20/50/30), nárazové špičky tlumeny. Je relativní vůči poolu.
- **LLM koeficient 0–10** — jak hluboko je jméno ve vahách modelů. Panel 7 modelů odpoví „kdo je X (nar. rok)?", odpověď se ověří proti Wikidatům (profese + národnost): 2/1/0. Hlasy malých modelů váží víc. Zaokrouhleno na 0–10.

Přesné vzorce, konstanty a rozhodnutí jsou v `PREDAVACI-PROTOKOL.md`.

## Konvence a technická pravidla

- **Žádný build, žádný backend, žádné localStorage** — stav je v paměti, vše v jednom souboru.
- **Wikidata SPARQL:** prosté GET bez vlastních hlaviček (jinak CORS preflight). Poolový dotaz držet štíhlý (bez label service nad celou populací → timeout/500); jména a profese tahat zvlášť „dekoračním" dotazem přes `VALUES` po dávkách ~150. Nikdy nepoužívat název vázané proměnné jako alias `GROUP_CONCAT(... AS ?x)` (→ HTTP 500).
- **Wikimedia pageviews:** měsíční endpoint vrátí celý rozsah v jednom requestu (24 měsíců = 1 volání na osobu).
- **OpenRouter:** jen hlavičky `Authorization` + `Content-Type` (minimalizace preflightu), `temperature:0`, `max_tokens:300` (reasoning modely jinak utnou odpověď). Slugy modelů se mění — jsou v editovatelném bloku `PANEL`; neplatný slug se projeví jako tečkované kolečko / přeškrtnutý model.
- **Seed nesmí pocházet z LLM** (kruhové zkreslení) — kandidáti vždy z Wikidat/pageviews.

## Nasazení

- **Web online:** https://cesi200.inspiruj.se
- **Repo:** https://github.com/miloscermak/znamost-cechu (veřejné).
- **Hosting:** Netlify napojený na repo (publish = `public/`, viz `netlify.toml`). `git push`
  s novým `public/data.json` → automatický deploy. Web nevolá AI, klíč nikde — měření je oddělené.
- **Přepočet dat:** `build-data.mjs` (klíč jen lokálně v `.openrouter-key`, gitignored). Viz README.

## Otevřené úkoly

- **Blocklist jmen pro web** — některá datově silná jména nemusí být vhodná pro publikaci
  (např. Nikita Denise); přidat seznam QID k vynechání při exportu.
- **Samostatné projekty pro propagaci workshopů/přednášek** — `wikifight` (zábava, zdarma) a
  `llmfight` (placené → jen s rozpočtovým stropem do vyčerpání). Budou to vlastní weby/repo.
- Mřížka model × osobnost (plná vizualizace) — odloženo.
- Volitelně soudce-model místo auto-verifikace (přesnější u „klíčového díla").
- Ruční doplnění online-native lidí (influenceři bez článku na Wikipedii).
