# Známost Čechů — data vs. AI

Měříme **známost osobností** dvěma nezávislými způsoby a srovnáváme je:

- **Koeficient z dat (0–1000)** — doložená encyklopedická a čtenářská stopa z otevřených zdrojů
  (Wikidata + Wikimedia), bez AI.
- **Koeficient z modelů (0–10)** — jak hluboko je jméno zakódované ve vahách jazykových modelů
  (panel 7 modelů přes OpenRouter).

Nejzajímavější je **rozdíl** mezi oběma čísly: koho zná Wikipedie, ale ne AI, a naopak.

## Veřejný web

`public/index.html` + `public/data.json` — statická stránka s žebříčkem top 200 žijících Čechů.
**Nevolá žádné AI**, jen zobrazuje předpočítaná čísla. To je celý web (Netlify publikuje složku `public/`).

Lokální náhled (kvůli `fetch` přes `file://`):

```bash
cd public && python3 -m http.server 8000
# → http://localhost:8000/index.html
```

## Měřící nástroje (vývoj / experimenty)

Samostatné HTML soubory, každý běží lokálně v prohlížeči bez backendu:

| Soubor | Co dělá |
|---|---|
| `ve-vahach-seed.html` | žebříček z dat, obory jako filtr |
| `wikifight.html` | souboj 2 osobností podle dat |
| `llmfight.html` | souboj 2 osobností podle znalosti modely |
| `top500llm.html` | žebříček z dat + LLM koeficient (+ export JSON pro web) |

LLM nástroje vyžadují OpenRouter klíč (zůstává jen v paměti stránky). Měření jsou placená.

## Přepočet dat (`build-data.mjs`)

Generátor `data.json` z příkazové řádky (Node 18+, bez závislostí). Sestaví žebříček z Wikidat +
Wikimedie a změří LLM panel přes OpenRouter. Odolný proti pádu (průběžná cache), resumovatelný.

```bash
# klíč do gitignorovaného souboru (nejde do shellu/historie)
read -s k && printf '%s' "$k" > .openrouter-key && unset k

node build-data.mjs            # pool 500, měří top 200 → public/data.json
```

Volitelně: `POOL=500 MEASURE=200 BORN_FROM=1935 CONC=4 node build-data.mjs`.
Pro čerstvá data smaž `.pool-cache.json` (a `.llm-cache.json` pro nové změření).

Náklady: 200 osob × 7 modelů = 1 400 placených dotazů na OpenRouter.

## Nasazení

Statický web — push do GitHubu, napojený Netlify deployuje automaticky. Přepočet = nový `data.json`,
commit, push. **Klíč ani cache se nikdy necommitují** (viz `.gitignore`).

## Dokumentace

Metodika, vzorce, konstanty a klíčová rozhodnutí: [`PREDAVACI-PROTOKOL.md`](PREDAVACI-PROTOKOL.md).
