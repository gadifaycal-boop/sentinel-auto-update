// Sentinel UK — script d'actualisation automatique
// Lit sources.json, récupère chaque page, demande à Claude d'en extraire
// les informations structurées, et met à jour data.json (avec archive).
//
// Nécessite Node.js 18+ (fetch natif) et la variable d'environnement
// ANTHROPIC_API_KEY (définie comme secret GitHub Actions).

import { readFile, writeFile } from "fs/promises";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

const CAT_KEYS = ["contrat", "industrie", "geopolitique", "techno", "nomination", "renseignement"];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

function stripHtml(html) {
  // Extraction de texte très simple (sans dépendance externe).
  // Suffisant pour des pages de communiqués / articles classiques.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSourceText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SentinelUKBot/1.0)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const text = stripHtml(raw);
  return text.slice(0, 12000); // on garde un extrait raisonnable
}

async function askClaude(promptText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: promptText }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("\n").trim();
}

async function extractItemsFromSource(source, companyNames) {
  const text = await fetchSourceText(source.url);
  const prompt = `Voici le contenu brut d'une page web (site: ${source.label || source.url}, type: ${source.type}).
Identifie s'il contient une ou plusieurs actualités RÉELLES et RÉCENTES liées à la défense (contrat, nomination, renseignement, industrie, technologie, géopolitique).
Réponds UNIQUEMENT avec un tableau JSON valide (peut être vide []), sans texte autour, sans balises markdown. Chaque élément :
{"title": string, "summary": string (3-4 lignes en français), "companies": [noms parmi: ${companyNames}], "countries": [noms de pays en français], "category": one of ${JSON.stringify(CAT_KEYS)}, "mod": boolean, "date": "YYYY-MM-DD ou null"}

Si le texte ne contient pas d'actualité défense exploitable, réponds [].

CONTENU:
"""${text}"""`;
  let out = await askClaude(prompt);
  out = out.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Réponse IA non parsable pour", source.url, out.slice(0, 300));
    return [];
  }
}

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY manquant — abandon.");
    process.exit(1);
  }

  const sources = await readJson("sources.json", []);
  const data = await readJson("data.json", { news: [], contracts: [], generatedAt: null, log: [] });
  const companyNames = (await readJson("companies.json", [])).map((c) => c.name).join(", ");

  const existingTitles = new Set(data.news.map((n) => (n.title || "").toLowerCase()));
  let added = 0;

  for (const source of sources) {
    try {
      const items = await extractItemsFromSource(source, companyNames);
      for (const item of items) {
        const key = (item.title || "").toLowerCase();
        if (!key || existingTitles.has(key)) continue; // évite les doublons
        existingTitles.add(key);
        data.news.unshift({
          id: "auto" + Date.now() + Math.floor(Math.random() * 1000),
          cat: CAT_KEYS.includes(item.category) ? item.category : "industrie",
          mod: !!item.mod,
          date: item.date || new Date().toISOString().slice(0, 10),
          companies: item.companies || [],
          countries: item.countries || [],
          title: item.title,
          summary: item.summary || "",
          source: source.label || source.url,
          url: source.url,
        });
        added++;
      }
      data.log.unshift({ ts: Date.now(), message: `OK — ${items.length} élément(s) analysé(s) — ${source.label || source.url}` });
    } catch (e) {
      data.log.unshift({ ts: Date.now(), message: `Échec — ${source.label || source.url} — ${e.message}` });
      console.error("Erreur source", source.url, e.message);
    }
  }

  data.log = data.log.slice(0, 300);
  data.generatedAt = new Date().toISOString();
  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log(`Terminé — ${added} nouvelle(s) actualité(s) ajoutée(s).`);
}

main();
