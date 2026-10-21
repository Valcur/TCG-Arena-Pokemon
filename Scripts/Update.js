#!/usr/bin/env node
/**
 * Mise à jour de la BDD Pokémon TCG pour TCG Arena, depuis l'API TCGdex.
 *
 *  1. Liste des sets : api.tcgdex.net/v2/en/sets
 *  2. Sets/SetList.json garde, pour chaque set, le nombre de cartes vu la dernière fois.
 *     Seuls les nouveaux sets, les sets dont le nombre de cartes a changé (ou incomplets)
 *     et les sets dont le fichier Sets/<setId>.json a été supprimé sont re-téléchargés.
 *  3. Dans ces sets, seules les cartes pas encore connues sont téléchargées (api.tcgdex.net/v2/en/cards/<id>)
 *  4. Génère PokemonCards.json (image = <image tcgdex>/high.webp) avec les données TCGdex.
 *     Carte sans image chez TCGdex : ancienne image gardée si elle vient de Scrydex / pokemontcg.io, sinon carte masquée.
 *     Les images manquantes sont revérifiées chaque semaine et remplacées par celles de TCGdex dès qu'elles existent.
 *  5. Anciennes cartes : un ancien ID absent (ancienne BDD pokemontcg.io) devient un alias vers la carte
 *     tcgdex correspondante (aliasOf). Si cette carte est masquée (pas d'image), l'ancien ID est mis en attente
 *     dans Scripts/pending-old-ids.json et revient automatiquement dès que TCGdex ajoute l'image.
 *  6. Rapport détaillé dans Scripts/update-report.md
 *
 * Emplacement : Scripts/Update.js (les chemins partent de la racine du repo)
 * Usage       : node Scripts/Update.js
 * Dépendances : aucune (Node 18+)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    apiBase: trimSlash(process.env.API_BASE || 'https://api.tcgdex.net/v2/en'),
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    // fichiers du jeu, relatifs à la racine du repo
    cardsFile: 'PokemonCards.json',
    setsDir: 'Sets',                       // Sets/SetList.json + Sets/<setId>.json
    setListFile: 'SetList.json',
    imageSuffix: '/high.webp',

    // fichiers internes, dans le dossier du script
    reportPath: path.join(__dirname, 'update-report.md'),
    pendingPath: path.join(__dirname, 'pending-old-ids.json'), // anciennes cartes masquées (pas d'image TCGdex), remises dès que l'image arrive

    // carte sans image chez TCGdex : on garde son ancienne image seulement si elle vient de ces sites (Scrydex / pokemontcg.io),
    // sinon la carte est masquée. Dans les deux cas, l'image TCGdex la remplace dès qu'elle existe.
    fallbackImageHosts: ['images.pokemontcg.io', 'images.scrydex.com'],

    excludedSeries: ['tcgp'],              // Pokémon TCG Pocket (autre jeu)
    excludedSets: [],                      // ex: ['jumbo']

    concurrency: 6,
    timeoutMs: 30_000,
    retries: 3,
    minRatioVsPrevious: 0.8,               // refuse d'écrire si on perd >20% des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-Pokemon-updater (+https://tcg-arena.fr)',
};

/**
 * Alias forcés à la main pour les anciens IDs : 'ANCIEN_ID': 'NOUVEL_ID'.
 * Sans entrée ici, le script retrouve tout seul la carte (même numéro + même nom dans le set correspondant, etc.).
 */
const ALIAS_OVERRIDES = {
};

const CACHE_FORMAT = 'tcgdex-v1'; // marqueur des fichiers Sets/<setId>.json (un ancien fichier sans ce marqueur est ignoré)

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = []; // { level: 'error' | 'warning', category, id, message }

function report(level, category, id, message) {
    issues.push({ level, category, id, message });
}

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return s.replace(/\/+$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function safeFileName(s) { return String(s).replace(/[<>:"/\\|?*\x00-\x1F%]/g, '_'); }
function decode(s) { try { return decodeURIComponent(s); } catch { return s; } }

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.relative(CONFIG.repoRoot, file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
}

async function runPool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

/** GET JSON avec retries sur erreurs réseau / 429 / 5xx → { data } | { notFound } | { error } */
async function getJson(url) {
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json' },
                signal: AbortSignal.timeout(CONFIG.timeoutMs),
            });
            if (res.status === 404 || res.status === 410) {
                try { await res.body?.cancel(); } catch { }
                return { notFound: true };
            }
            if (res.status === 429 || res.status >= 500) {
                try { await res.body?.cancel(); } catch { }
                lastError = `HTTP ${res.status}`;
            } else if (!res.ok) {
                try { await res.body?.cancel(); } catch { }
                return { error: `HTTP ${res.status}` };
            } else {
                const text = await res.text();
                try {
                    return { data: JSON.parse(text) };
                } catch (e) {
                    return { error: `JSON invalide (${e.message})` };
                }
            }
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(1000 * 2 ** (attempt - 1));
    }
    return { error: lastError };
}

// ─────────────────────────────── Téléchargement ───────────────────────────────

const stats = { setsNew: [], setsUpdated: [], setsIncomplete: [], setsImages: [], setsExcluded: [], cardsDownloaded: 0, cardsFailed: 0, imagesFound: 0 };

function setFilePath(setId) {
    return rel(CONFIG.setsDir, `${safeFileName(setId)}.json`);
}

/** Ne garde que ce qui sert à PokemonCards.json et au rapprochement des anciens IDs */
function minimalCard(c, setId) {
    return {
        id: c.id,
        localId: c.localId,
        set: setId,
        name: c.name,
        category: c.category,
        trainerType: c.trainerType,
        energyType: c.energyType,
        stage: c.stage,
        rarity: c.rarity,
        hp: c.hp,
        types: c.types,
        retreat: c.retreat,
        image: c.image,
        updated: c.updated,
    };
}

/**
 * Télécharge le détail d'un set puis uniquement ses cartes inconnues (ou en échec la fois précédente).
 * Retourne le contenu à écrire dans Sets/<setId>.json, ou null si le set est exclu / inaccessible.
 */
async function updateSet(apiSet, cached) {
    const id = apiSet.id;
    const detail = await getJson(`${CONFIG.apiBase}/sets/${encodeURIComponent(id)}`);
    if (detail.error || detail.notFound || !Array.isArray(detail.data?.cards)) {
        const why = detail.error || (detail.notFound ? 'HTTP 404' : 'pas de tableau "cards"');
        report(cached ? 'warning' : 'error', cached ? 'Set non mis à jour (fichier local utilisé)' : 'Set inaccessible (ignoré)', id, why);
        return null;
    }
    const d = detail.data;
    const info = {
        id,
        name: d.name || apiSet.name,
        serie: d.serie?.id || null,
        serieName: d.serie?.name || null,
        releaseDate: d.releaseDate || null,
        code: d.tcgOnline || (d.abbreviation?.official ? String(d.abbreviation.official).split(':')[0] : null),
        cardCount: d.cardCount || apiSet.cardCount || null,
    };
    if (CONFIG.excludedSeries.includes(info.serie)) return { excluded: true, info };

    const known = cached?.cards || {};
    const cards = {};
    const todo = [];
    for (const r of d.cards) {
        if (!r?.id) continue;
        if (known[r.id] && !known[r.id].retry) {
            cards[r.id] = known[r.id];
            // image ajoutée par TCGdex depuis le dernier passage
            if (!cards[r.id].image && r.image) {
                cards[r.id] = { ...cards[r.id], image: r.image };
                stats.imagesFound++;
            }
        } else {
            todo.push(r);
        }
    }
    if (todo.length) console.log(`   ${id} : ${todo.length} carte(s) à télécharger`);
    let done = 0;
    await runPool(todo, CONFIG.concurrency, async r => {
        let res = await getJson(`${CONFIG.apiBase}/cards/${encodeURIComponent(r.id)}`);
        if (res.notFound) res = await getJson(`${CONFIG.apiBase}/cards/${r.id}`); // id déjà encodé (ex: exu-%3F)
        if (res.data?.id) {
            cards[r.id] = minimalCard(res.data, id);
            stats.cardsDownloaded++;
        } else {
            // échec : on garde le résumé du set et on retentera au prochain run
            cards[r.id] = { ...minimalCard({ id: r.id, localId: r.localId, name: r.name, image: r.image }, id), retry: true };
            stats.cardsFailed++;
            report('warning', 'Cartes non téléchargées (retentées au prochain run, données partielles en attendant)', r.id, res.error || 'HTTP 404');
        }
        if (++done % 200 === 0) console.log(`      ${done}/${todo.length}`);
    });
    const removed = Object.keys(known).filter(k => !cards[k]);
    if (removed.length) report('warning', 'Cartes retirées d\'un set par TCGdex', id, removed.join(', '));

    return { source: CACHE_FORMAT, set: info, updatedAt: new Date().toISOString(), cards };
}

// ─────────────────────────────── Format PokemonCards.json ───────────────────────────────

function cardType(c) {
    const cat = String(c.category || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (cat === 'Pokemon') return 'Pokemon';
    if (cat === 'Trainer') {
        switch (c.trainerType) {
            case 'Item': return 'Trainer - Item';
            case 'Supporter': return 'Trainer - Supporter';
            case 'Stadium': return 'Trainer - Stadium';
            case 'Tool': return 'Trainer - Pokemon tool';
            default: return 'Trainer';
        }
    }
    if (cat === 'Energy') return c.energyType === 'Special' ? 'Energy - Special' : 'Energy';
    return cat || 'Unknown';
}

/** "001" → "1" ; "TG01", "SV001", "SWSH001" inchangés ; "%3F" → "?" */
function displayNumber(localId) {
    const n = decode(String(localId));
    return /^\d+$/.test(n) ? String(Number(n)) : n;
}

function buildCardEntry(c, setInfo) {
    let name = String(c.name || '?');
    if (c.stage === 'LEVEL-UP' && !/LV\.?X/i.test(name)) name += ' LV.X';
    const fullName = [name, setInfo?.code, displayNumber(c.localId)].filter(Boolean).join(' ');
    const type = cardType(c);
    const image = c.image ? `${c.image}${CONFIG.imageSuffix}` : '';
    const entry = {
        id: c.id,
        face: {
            front: { name: fullName, type, cost: 0, image, isHorizontal: false },
        },
        name: fullName,
        type,
        cost: 0,
        set: c.set,
        rarity: c.rarity && c.rarity !== 'None' ? c.rarity : undefined,
        'Retreat cost': typeof c.retreat === 'number' ? c.retreat : undefined,
        hp: c.hp ? Number(c.hp) || 0 : 0,
        types: Array.isArray(c.types) ? c.types : [],
    };
    return entry;
}

// ─────────────────────────────── Anciens IDs : rapprochement ───────────────────────────────

/** Numéro comparable : "001" = "1", "TG01" = "TG1", "H01" = "H1", "%3F" = "?" */
function normNum(s) {
    return decode(String(s)).toUpperCase().replace(/[^A-Z0-9!?]/g, '').replace(/(^|[^0-9])0+(?=\d)/g, '$1');
}

/** Nom comparable : sans accents ni ponctuation, "★" = "star", "LV.X" ignoré, "Basic X Energy" = "X Energy" */
function normName(s) {
    let n = String(s).replace(/[★☆]/g, ' star ').replace(/δ/g, ' delta ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    n = n.replace(/lvx$/, '');
    if (n.endsWith('energy')) n = n.replace(/^basic/, '');
    return n;
}

function oldSetOf(id) { return id.slice(0, id.lastIndexOf('-')); }
function oldNumOf(id) { return id.slice(id.lastIndexOf('-') + 1); }

/**
 * Pour chaque ancienne carte absente des nouvelles :
 *  1. ALIAS_OVERRIDES   2. alias déjà existant
 *  3. set correspondant (trouvé d'après le contenu : mêmes numéros + mêmes noms), puis dans ce set :
 *     même numéro + même nom → sinon même nom (unique) → sinon même numéro + nom proche
 *     → sinon variante "19a" → "19", "50" → "50a"
 *  4. cartes restantes : 2e recherche de set (ex: les Unown de Unseen Forces sont dans un set à part)
 *  Retourne les alias (la cible peut être une carte masquée) et les anciennes cartes introuvables ("kept").
 */
function resolveOldIds(previousCards, out, setCodes) {
    const real = Object.values(out);
    const realIds = new Set(Object.keys(out));
    const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);

    const keyIdx = new Map();   // numéro|nom → cartes
    const nameIdx = new Map();  // nom → cartes
    const inSet = new Map();    // set → { byKey, byName, byNum, all }
    for (const c of real) {
        const k = normNum(c._localId) + '|' + normName(c._baseName);
        push(keyIdx, k, c);
        push(nameIdx, normName(c._baseName), c);
        if (!inSet.has(c.set)) inSet.set(c.set, { byKey: new Map(), byName: new Map(), byNum: new Map(), all: [] });
        const s = inSet.get(c.set);
        push(s.byKey, k, c);
        push(s.byName, normName(c._baseName), c);
        push(s.byNum, normNum(c._localId), c);
        s.all.push(c);
    }

    // anciennes cartes groupées par ancien set + code de set présent dans leurs noms ("Bulbasaur MEW 1")
    const oldBySet = {};
    for (const [id, o] of Object.entries(previousCards)) {
        if (!o || o.aliasOf || !o.name) continue;
        (oldBySet[oldSetOf(id)] ??= []).push(id);
    }
    const codeOf = {};
    for (const [s, ids] of Object.entries(oldBySet)) {
        const tally = {};
        for (const id of ids) {
            const toks = previousCards[id].name.split(' ');
            const num = oldNumOf(id).split('_')[0];
            if (toks.length >= 3 && toks.at(-1) === num) tally[toks.at(-2)] = (tally[toks.at(-2)] || 0) + 1;
        }
        const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
        codeOf[s] = best && best[1] >= ids.length * 0.6 && /^[A-Z0-9][A-Z0-9-]+$/.test(best[0]) ? best[0] : null;
    }
    const baseName = id => {
        let n = previousCards[id].name;
        const num = oldNumOf(id).split('_')[0];
        if (n.endsWith(' ' + num)) n = n.slice(0, -num.length - 1);
        const code = codeOf[oldSetOf(id)];
        if (code && n.endsWith(' ' + code)) n = n.slice(0, -code.length - 1);
        return n;
    };

    /**
     * Set tcgdex qui contient le plus de ces cartes (par numéro+nom, sinon par nom seul).
     * En cas d'égalité : même code de set que dans les anciens noms (ex: "SVE"), puis même ID de set ; sinon aucun.
     */
    const bestSet = (ids, minRatio, oldSet) => {
        const tally = lookup => {
            const sc = {};
            for (const id of ids) for (const s of new Set((lookup(id) || []).map(c => c.set))) sc[s] = (sc[s] || 0) + 1;
            const sorted = Object.entries(sc).sort((a, b) => b[1] - a[1]);
            if (!sorted.length) return null;
            let top = sorted.filter(([, n]) => n === sorted[0][1]);
            if (top.length > 1 && codeOf[oldSet]) top = top.filter(([s]) => setCodes[s] === codeOf[oldSet]);
            if (top.length > 1) top = top.filter(([s]) => s === oldSet);
            return top.length === 1 ? top[0] : null;
        };
        let best = tally(id => keyIdx.get(normNum(oldNumOf(id)) + '|' + normName(baseName(id))));
        if (!best || best[1] < ids.length * minRatio) {
            const byName = tally(id => nameIdx.get(normName(baseName(id))));
            if (byName && byName[1] >= ids.length * 0.5) best = byName;
        }
        return best && best[1] >= Math.max(1, ids.length * minRatio) ? best[0] : null;
    };

    /** Cherche une ancienne carte dans un set tcgdex donné */
    const matchIn = (id, setId) => {
        const s = inSet.get(setId);
        if (!s) return null;
        const num = oldNumOf(id), nm = normName(baseName(id));
        const one = a => (a && a.length === 1 ? a[0] : null);
        let c = one(s.byKey.get(normNum(num) + '|' + nm));
        if (c) return { target: c.id, how: 'même numéro et même nom' };
        c = one(s.byName.get(nm));
        if (c) return { target: c.id, how: `même nom, numéro ${num} → ${c._localId}`, approx: true };
        c = one((s.byNum.get(normNum(num)) || []).filter(x => { const n2 = normName(x._baseName); return n2.includes(nm) || nm.includes(n2); }));
        if (c) return { target: c.id, how: `même numéro, nom "${c._baseName}"`, approx: true };
        if (/\d[A-Za-z]+$/.test(num)) {                       // ancienne variante "19a" → carte "19"
            c = one(s.byKey.get(normNum(num.replace(/[A-Za-z]+$/, '')) + '|' + nm));
            if (c) return { target: c.id, how: `variante ${num} absente → ${c._localId}`, approx: true };
        }
        const withLetter = s.all.filter(x => normName(x._baseName) === nm && new RegExp(`^${normNum(num)}[A-Z]+$`).test(normNum(x._localId)))
            .sort((a, b) => a._localId.localeCompare(b._localId));
        if (withLetter.length) return { target: withLetter[0].id, how: `numéro ${num} → ${withLetter[0]._localId} (variantes : ${withLetter.map(x => x._localId).join(', ')})`, approx: true };
        return null;
    };

    const raw = {};
    const kept = {};
    const setMap = {};
    const missingBySet = {};
    for (const oldId of new Set([...Object.keys(previousCards), ...Object.keys(ALIAS_OVERRIDES)])) {
        if (realIds.has(oldId)) continue;
        const prev = previousCards[oldId];
        if (ALIAS_OVERRIDES[oldId]) { raw[oldId] = { target: ALIAS_OVERRIDES[oldId], how: 'manuel' }; continue; }
        if (prev?.aliasOf) { raw[oldId] = { target: prev.aliasOf, how: 'alias existant', carried: true }; continue; }
        if (!prev?.name) { if (prev) kept[oldId] = prev; continue; }
        (missingBySet[oldSetOf(oldId)] ??= []).push(oldId);
    }
    for (const [oldSet, ids] of Object.entries(missingBySet)) {
        const target = bestSet(oldBySet[oldSet] || ids, 0.3, oldSet);
        setMap[oldSet] = target;
        let left = [];
        for (const id of ids) {
            const m = target && matchIn(id, target);
            if (m) raw[id] = m; else left.push(id);
        }
        if (left.length) {                                    // 2e passe sur les cartes restantes
            const second = bestSet(left, 0.5, oldSet);
            if (second && second !== target) {
                setMap[oldSet] += ` + ${second}`;
                left = left.filter(id => { const m = matchIn(id, second); if (m) raw[id] = m; return !m; });
            }
        }
        for (const id of left) kept[id] = previousCards[id];
    }

    // aplatit les chaînes A→B→C (le moteur ne suit qu'un niveau)
    const aliases = {};
    for (const [oldId, a] of Object.entries(raw)) {
        let target = a.target;
        const seen = new Set([oldId]);
        while (!realIds.has(target) && raw[target] && !seen.has(target)) {
            seen.add(target);
            target = raw[target].target;
        }
        if (realIds.has(target)) aliases[oldId] = { ...a, target };
        else if (previousCards[oldId] && !previousCards[oldId].aliasOf) kept[oldId] = previousCards[oldId];
        else report('warning', 'Alias impossible : la carte cible n\'existe plus', oldId, `cible "${a.target}" (${a.how})`);
    }
    return { aliases, kept, setMap };
}

// ─────────────────────────────── Rapport ───────────────────────────────

function translationSnippet(newCodes) {
    return newCodes.map(c => `        ${JSON.stringify(c.code)}: ${JSON.stringify(c.suggestion)},`).join('\n');
}

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const v = summary.verification;
    const lines = [];
    lines.push(`# Mise à jour des cartes Pokémon — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    lines.push(`| Sets dans l'API | ${summary.apiSetCount} (dont ${stats.setsExcluded.length} exclus : TCG Pocket…) |`);
    lines.push(`| Nouveaux sets | ${stats.setsNew.join(', ') || '—'} |`);
    lines.push(`| Sets mis à jour (nombre de cartes changé) | ${stats.setsUpdated.join(', ') || '—'} |`);
    lines.push(`| Sets incomplets re-vérifiés | ${stats.setsIncomplete.length ? stats.setsIncomplete.join(', ') : '—'} |`);
    lines.push(`| Sets re-vérifiés pour leurs images manquantes | ${stats.setsImages.length} (images trouvées : ${stats.imagesFound}) |`);
    lines.push(`| Cartes téléchargées ce run | ${stats.cardsDownloaded} (échecs : ${stats.cardsFailed}) |`);
    lines.push(`| Cartes dans ${CONFIG.cardsFile} | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Cartes avec image Scrydex / pokemontcg.io (en attendant TCGdex) | ${summary.fallback} |`);
    lines.push(`| Cartes masquées (aucune image) | ${summary.hidden} |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    if (v) {
        lines.push('## ✅ Vérification des anciennes cartes', '');
        lines.push(`- Anciennes entrées (cartes, alias, cartes en attente) : **${v.total}**`);
        lines.push(`- Présentes avec le même ID : **${v.direct}**`);
        lines.push(`- Redirigées par alias vers la carte TCGdex : **${v.aliased}** (dont ${v.approx} nouveaux approximatifs, listés plus bas)`);
        lines.push(`- Masquées en attente d'image TCGdex (reviendront automatiquement) : **${v.hidden}**`);
        lines.push(`- Introuvables chez TCGdex (retentées à chaque run) : **${v.unmatched}**`);
        lines.push(`- Perdues : **${v.lost}**`, '');
        if (summary.hiddenOld?.length) {
            lines.push(`<details><summary>Anciennes cartes masquées (${summary.hiddenOld.length})</summary>`, '');
            lines.push(summary.hiddenOld.map(id => `\`${id}\``).join(' '), '', '</details>', '');
        }
    }
    if (summary.setMap && Object.keys(summary.setMap).length) {
        lines.push('## 🔀 Correspondance anciens sets → sets TCGdex', '');
        lines.push(Object.entries(summary.setMap).map(([o, n]) => `\`${o}\` → \`${n ?? '?'}\``).join(' · '), '');
    }
    if (summary.newCodes.length) {
        lines.push(`## 🌐 Nouveaux codes à traduire (${summary.newCodes.length})`, '');
        lines.push('À coller dans l\'objet `"en"` de translations.json (sets pré-remplis avec le nom TCGdex, raretés à compléter) :', '');
        lines.push('```json', translationSnippet(summary.newCodes), '```', '');
    }

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.slice(0, 400).forEach(i => lines.push(`- \`${i.id}\` — ${i.message}`));
            if (items.length > 400) lines.push(`- … et ${items.length - 400} autre(s)`);
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.added.length) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        const bySet = new Map();
        for (const id of summary.added) {
            const s = id.slice(0, id.lastIndexOf('-'));
            bySet.set(s, (bySet.get(s) || 0) + 1);
        }
        lines.push([...bySet].map(([s, n]) => `\`${s}\` ${n}`).join(' · '), '');
    }
    return lines.join('\n');
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir Scripts/update-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id} : ${i.message}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = { apiSetCount: 0, cardCount: 0, previousCount: 0, hidden: 0, fallback: 0, hiddenOld: [], added: [], newCodes: [], verification: null, setMap: null, fatal: null };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const setListPath = rel(CONFIG.setsDir, CONFIG.setListFile);
        const previousCards = await readJsonIfExists(cardsPath, {});
        summary.previousCount = Object.values(previousCards).filter(c => !c?.aliasOf).length;
        const setList = await readJsonIfExists(setListPath, { sets: {} });
        setList.sets ||= {};

        // ── 1. Liste des sets ──
        console.log(`📋 Liste des sets : ${CONFIG.apiBase}/sets`);
        const list = await getJson(`${CONFIG.apiBase}/sets`);
        let apiSets = [];
        if (list.error || !Array.isArray(list.data)) {
            report('error', 'Liste des sets inaccessible (seuls les fichiers de Sets/ sont utilisés)', 'sets', list.error || 'réponse inattendue');
        } else {
            apiSets = list.data.filter(s => s?.id && !CONFIG.excludedSets.includes(s.id));
        }
        summary.apiSetCount = apiSets.length;

        // ── 2. Sets nouveaux / modifiés / incomplets / fichier supprimé ──
        const todo = [];
        for (const s of apiSets) {
            const known = setList.sets[s.id];
            const total = s.cardCount?.total ?? null;
            if (known?.excluded) { stats.setsExcluded.push(s.id); continue; }
            const file = setFilePath(s.id);
            let reason = null;
            if (!known) reason = 'nouveau';
            else if (!fs.existsSync(file)) reason = 'fichier absent';
            else if (known.total !== total) reason = `${known.total} → ${total} cartes`;
            else if (known.cards < total || known.retry) reason = known.retry ? 'cartes à retenter' : `incomplet (${known.cards}/${total})`;
            else if (known.noImage) reason = `${known.noImage} image(s) manquante(s)`;
            if (reason) todo.push({ s, reason });
        }
        console.log(`   ${apiSets.length} set(s), ${todo.length} à vérifier\n`);

        for (const { s, reason } of todo) {
            const file = setFilePath(s.id);
            let cached = await readJsonIfExists(file, null);
            if (cached && cached.source !== CACHE_FORMAT) cached = null; // ancien format → ignoré, re-téléchargé
            console.log(`📥 ${s.id} (${s.name}) — ${reason}`);
            const res = await updateSet(s, cached);
            if (!res) continue;
            if (res.excluded) {
                setList.sets[s.id] = { name: s.name, serie: res.info.serie, excluded: true };
                stats.setsExcluded.push(s.id);
                continue;
            }
            await writeFileAtomic(file, JSON.stringify(res, null, 2) + '\n');
            const count = Object.keys(res.cards).length;
            const retry = Object.values(res.cards).some(c => c.retry);
            const noImage = Object.values(res.cards).filter(c => !c.image).length;
            setList.sets[s.id] = {
                name: res.set.name, serie: res.set.serie, releaseDate: res.set.releaseDate,
                total: s.cardCount?.total ?? null, cards: count, noImage: noImage || undefined, retry: retry || undefined,
            };
            if (reason === 'nouveau' || reason === 'fichier absent') stats.setsNew.push(s.id);
            else if (reason.startsWith('incomplet')) stats.setsIncomplete.push(s.id);
            else if (reason.includes('image')) stats.setsImages.push(s.id);
            else stats.setsUpdated.push(s.id);
            if (count < (s.cardCount?.total ?? 0)) {
                report('warning', 'Sets incomplets chez TCGdex (re-vérifiés à chaque run)', s.id, `${count}/${s.cardCount.total} cartes`);
            }
        }
        setList.updatedAt = new Date().toISOString();
        setList.sets = Object.fromEntries(Object.keys(setList.sets).sort().map(k => [k, setList.sets[k]]));
        await writeFileAtomic(setListPath, JSON.stringify(setList, null, 2) + '\n');

        // ── 3. Construction de PokemonCards.json depuis Sets/ ──
        const order = new Map(apiSets.map((s, i) => [s.id, i])); // l'API trie par date de sortie
        const setIds = Object.keys(setList.sets).filter(id => !setList.sets[id].excluded && !CONFIG.excludedSets.includes(id))
            .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
        const all = {};      // toutes les cartes TCGdex, y compris celles sans image
        const setNames = new Map();
        const setCodes = {};
        for (const setId of setIds) {
            const data = await readJsonIfExists(setFilePath(setId), null);
            if (!data || data.source !== CACHE_FORMAT) {
                report('error', 'Fichier de set manquant ou invalide (relance le script)', setId, '');
                continue;
            }
            setNames.set(setId, data.set?.name || setId);
            setCodes[setId] = data.set?.code || null;
            const cards = Object.values(data.cards).sort((a, b) =>
                (parseInt(a.localId, 10) || 1e9) - (parseInt(b.localId, 10) || 1e9) || String(a.localId).localeCompare(String(b.localId)));
            for (const c of cards) {
                if (all[c.id]) { report('warning', 'Doublons d\'ID (première occurrence gardée)', c.id, setId); continue; }
                all[c.id] = buildCardEntry(c, data.set);
                Object.defineProperty(all[c.id], '_localId', { value: decode(String(c.localId)), enumerable: false });
                Object.defineProperty(all[c.id], '_baseName', { value: String(c.name || ''), enumerable: false });
            }
        }

        // ── 4. Anciens IDs → carte TCGdex correspondante ──
        // anciennes cartes masquées lors des runs précédents (absentes de PokemonCards.json)
        const pending = await readJsonIfExists(CONFIG.pendingPath, {});
        const oldInput = { ...previousCards };
        for (const [oldId, p] of Object.entries(pending)) {
            if (oldInput[oldId]) continue;
            oldInput[oldId] = p.target && p.target !== oldId ? { id: oldId, aliasOf: p.target, name: p.name } : { id: oldId, name: p.name };
        }
        const { aliases, kept, setMap } = resolveOldIds(oldInput, all, setCodes);
        summary.setMap = Object.keys(setMap).length ? setMap : null;

        // ── 5. Pas d'image TCGdex : ancienne image Scrydex / pokemontcg.io si on l'a, sinon carte masquée ──
        const allowedImage = url => { try { return CONFIG.fallbackImageHosts.includes(new URL(url).host); } catch { return false; } };
        const oldImageOf = oldId => [oldInput[oldId]?.face?.front?.image, pending[oldId]?.image].find(u => u && allowedImage(u));
        const sourcesOf = {};
        for (const [oldId, a] of Object.entries(aliases)) (sourcesOf[a.target] ??= []).push(oldId);
        const fallbackBySet = {}, hiddenBySet = {};
        for (const [id, e] of Object.entries(all)) {
            if (e.face.front.image) continue;
            const img = [id, ...(sourcesOf[id] || [])].map(oldImageOf).find(Boolean);
            if (img) {
                e.face.front.image = img;
                fallbackBySet[e.set] = (fallbackBySet[e.set] || 0) + 1;
            } else {
                hiddenBySet[e.set] = (hiddenBySet[e.set] || 0) + 1;
            }
        }
        for (const [setId, n] of Object.entries(fallbackBySet)) {
            report('warning', 'Pas d\'image chez TCGdex : ancienne image Scrydex / pokemontcg.io utilisée en attendant', setId, `${n} carte(s) — ${setNames.get(setId)}`);
        }
        for (const [setId, n] of Object.entries(hiddenBySet)) {
            report('warning', 'Cartes masquées : aucune image (revérifiées chaque semaine)', setId, `${n} carte(s) — ${setNames.get(setId)}`);
        }
        summary.hidden = Object.values(hiddenBySet).reduce((a, b) => a + b, 0);
        summary.fallback = Object.values(fallbackBySet).reduce((a, b) => a + b, 0);

        // seules les cartes avec une image vont dans PokemonCards.json
        const out = Object.fromEntries(Object.entries(all).filter(([, e]) => e.face.front.image));
        const realIds = Object.keys(out);
        if (!realIds.length) throw new FatalError('Aucune carte exploitable');
        if (summary.previousCount && realIds.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} cartes contre ${summary.previousCount} dans le ${CONFIG.cardsFile} actuel. ` +
                'Probable problème côté API. Relancer avec FORCE=1 pour écraser quand même.');
        }
        summary.added = realIds.filter(id => !(id in previousCards));

        // ── 6. Alias, ou mise en attente si la carte est masquée ──
        const pendingNew = {};
        const revived = [];
        for (const [oldId, a] of Object.entries(aliases)) {
            if (out[a.target]) {
                out[oldId] = { id: oldId, aliasOf: a.target };
                if (pending[oldId]) revived.push(oldId);
                if (!a.carried && a.approx) report('warning', 'Alias approximatifs (vérifie que c\'est la bonne carte)', oldId, `${oldInput[oldId]?.name || ''} → ${a.target} (${a.how})`);
            } else {
                pendingNew[oldId] = { name: oldInput[oldId]?.name || pending[oldId]?.name || '', target: a.target, image: oldImageOf(oldId) };
                if (!a.carried && a.approx) report('warning', 'Alias approximatifs (vérifie que c\'est la bonne carte)', oldId, `${oldInput[oldId]?.name || ''} → ${a.target} (${a.how}) — carte masquée pour l'instant`);
            }
        }
        // ancien ID identique à une carte TCGdex masquée → en attente de son image
        for (const oldId of Object.keys(oldInput)) {
            if (oldInput[oldId]?.aliasOf || !all[oldId]) continue;
            if (out[oldId]) { if (pending[oldId]) revived.push(oldId); }
            else pendingNew[oldId] = { name: oldInput[oldId]?.name || '', target: oldId, image: oldImageOf(oldId) };
        }
        // introuvables chez TCGdex : retirées (pas de carte hors TCGdex), retentées à chaque run
        for (const [oldId, entry] of Object.entries(kept)) {
            pendingNew[oldId] = { name: entry.name || pending[oldId]?.name || '', target: null, image: oldImageOf(oldId) };
            report('warning', 'Anciennes cartes introuvables chez TCGdex (retirées, retentées à chaque run)', oldId, `${entry.name || ''} — ajoute un alias dans ALIAS_OVERRIDES si tu connais la nouvelle carte`);
        }
        for (const oldId of revived) report('warning', 'Anciennes cartes revenues (image trouvée)', oldId, out[oldId]?.aliasOf ? `→ ${out[oldId].aliasOf}` : '');
        const sortedPending = Object.fromEntries(Object.keys(pendingNew).sort().map(k => [k, pendingNew[k]]));
        if (Object.keys(sortedPending).length) await writeFileAtomic(CONFIG.pendingPath, JSON.stringify(sortedPending, null, 2) + '\n');
        else await fsp.rm(CONFIG.pendingPath, { force: true });

        const oldUniverse = Object.keys(oldInput); // tout ce qui existait avant : cartes, alias et cartes en attente
        summary.verification = {
            total: oldUniverse.length,
            direct: oldUniverse.filter(id => out[id] && !out[id].aliasOf).length,
            aliased: oldUniverse.filter(id => out[id]?.aliasOf).length,
            approx: oldUniverse.filter(id => out[id]?.aliasOf && aliases[id]?.approx).length,
            hidden: oldUniverse.filter(id => pendingNew[id]?.target).length,
            unmatched: oldUniverse.filter(id => pendingNew[id] && !pendingNew[id].target).length,
            lost: oldUniverse.filter(id => !out[id] && !pendingNew[id]).length,
        };
        summary.hiddenOld = Object.keys(pendingNew).filter(id => pendingNew[id].target);

        // ── 7. Nouveaux codes (set / rareté) pour translations.json ──
        const known = new Set(Object.values(previousCards).flatMap(c => [c?.set, c?.rarity]).filter(Boolean));
        for (const field of ['set', 'rarity']) {
            for (const id of realIds) {
                const code = out[id][field];
                if (!code || known.has(code)) continue;
                known.add(code);
                summary.newCodes.push({ code, suggestion: field === 'set' ? (setNames.get(code) || '') : '' });
            }
        }

        // ── 8. Écriture ──
        await writeFileAtomic(cardsPath, JSON.stringify(out, null, 2) + '\n');
        summary.cardCount = realIds.length;

        const v = summary.verification;
        const nAlias = Object.values(out).filter(c => c.aliasOf).length;
        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes (${summary.added.length} nouvelles, ${summary.fallback} avec image Scrydex en attendant TCGdex) + ${nAlias} alias — ${summary.hidden} carte(s) masquée(s) faute d'image`);
        if (v.total) console.log(`✅ Anciennes cartes : ${v.total} → ${v.direct} identiques, ${v.aliased} via alias (${v.approx} approximatifs), ${v.hidden} masquées en attente d'image, ${v.unmatched} introuvables, ${v.lost} perdue(s)`);
        if (stats.imagesFound) console.log(`🖼️  ${stats.imagesFound} image(s) ajoutée(s) par TCGdex depuis le dernier run`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    if (summary.newCodes.length) {
        console.log(`\n🌐 ${summary.newCodes.length} nouveau(x) code(s) à traduire — à coller dans "en" de translations.json :\n`);
        console.log(translationSnippet(summary.newCodes));
    }
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
