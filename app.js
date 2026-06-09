/**
 * app.js — Ricerca Brevetti (v3 — copertura globale)
 *
 * FONTI DATI:
 *   ┌─ USPTO PatentsView (https://search.rpatentview.com/api/v1/)
 *   │   Gratuita · No auth · Solo brevetti USA
 *   │
 *   └─ Lens.org API (https://api.lens.org/patent/search)
 *       Gratuita con token · Copertura globale (US · EP · WO · CN · JP · +90 paesi)
 *       Token gratuito: https://www.lens.org/lens/user/subscriptions#
 *
 * CORS
 *   Le API target non abilitano CORS per origini browser esterne.
 *   Tutte le chiamate passano attraverso un proxy CORS pubblico
 *   con fallback automatico (corsproxy.io → codetabs.com).
 *
 * MODALITÀ:
 *   – Senza token Lens.org → solo USPTO (brevetti USA)
 *   – Con token Lens.org   → USPTO + Lens.org in parallelo (copertura globale)
 *
 * PIPELINE:
 *   Agent 1 – Orchestratore  : avvio e coordinamento
 *   Agent 2 – Ricerca        : query parallele USPTO + Lens.org
 *   Agent 3 – Verifica       : deduplicazione + classificazione conformi/scartati
 *   Agent 4 – Reporting      : rendering tabella
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   COSTANTI API
═══════════════════════════════════════════════════════════════ */
const PATENTSVIEW_URL = 'https://search.rpatentview.com/api/v1/patents/query';
const LENS_URL        = 'https://api.lens.org/patent/search';

/* ── CORS PROXY ──────────────────────────────────────────────────
   Le API esterne (USPTO PatentsView, Lens.org) non restituiscono
   header Access-Control-Allow-Origin per origini browser esterne,
   indipendentemente dal protocollo (file://, http://, https://).
   Tutte le chiamate passano quindi attraverso un proxy CORS pubblico
   con fallback automatico al secondo proxy in caso di errore.
────────────────────────────────────────────────────────────────── */

/**
 * Lista di CORS proxy pubblici, ordinati per affidabilità.
 * Ogni entry è una funzione (url) => proxiedUrl.
 * Supportano POST con corpo JSON.
 */
const CORS_PROXIES = [
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

/**
 * Esegue fetch() con fallback automatico su più CORS proxy.
 * Tutte le chiamate vengono proxate — le API target non abilitano
 * CORS per origini browser esterne (né da file:// né da https://).
 *
 * @param {string}      url
 * @param {RequestInit} options
 * @returns {Promise<Response>}
 */
const proxyFetch = async (url, options = {}) => {
    console.group('[proxyFetch] tentativo con proxy CORS');
    console.log('Target URL:', url);

    let lastErr = null;
    for (const makeProxy of CORS_PROXIES) {
        const proxied = makeProxy(url);
        try {
            console.log('Trying proxy:', proxied);
            const resp = await fetch(proxied, options);
            console.log('Success! HTTP', resp.status);
            console.groupEnd();
            return resp;
        } catch (e) {
            console.warn('Proxy failed:', e.message);
            lastErr = e;
        }
    }

    console.error('Tutti i proxy CORS hanno fallito.');
    console.groupEnd();
    throw new Error(
        `CORS bloccato — tutti i proxy hanno fallito. Riprova tra qualche istante.`
    );
};


/**
 * Mappa codici giurisdizione → etichetta leggibile.
 * Lens.org usa codici paese ISO + EP per Europa, WO per internazionale.
 */
const JURISDICTION_LABELS = {
    US: '🇺🇸 USA',
    EP: '🇪🇺 Europa (EPO)',
    WO: '🌍 Internazionale (PCT)',
    CN: '🇨🇳 Cina',
    JP: '🇯🇵 Giappone',
    DE: '🇩🇪 Germania',
    FR: '🇫🇷 Francia',
    GB: '🇬🇧 Regno Unito',
    IT: '🇮🇹 Italia',
    KR: '🇰🇷 Corea del Sud',
    IN: '🇮🇳 India',
    CA: '🇨🇦 Canada',
    AU: '🇦🇺 Australia',
    BR: '🇧🇷 Brasile',
};
const labelJurisdiction = code => JURISDICTION_LABELS[code] || code || '—';

document.addEventListener('DOMContentLoaded', () => {

    /* ── DOM REFS ─────────────────────────────────────────────── */
    const btnAvvia      = document.getElementById('btn-avvia');
    const btnReset      = document.getElementById('btn-reset');
    const btnExport     = document.getElementById('btn-export');
    const btnToggleToken= document.getElementById('btn-toggle-token');
    const aziendaEl     = document.getElementById('azienda');
    const prodottoEl    = document.getElementById('prodotto');
    const lensTokenEl   = document.getElementById('lens-token');
    const iconEye       = document.getElementById('icon-eye');
    const coverageBadge = document.getElementById('coverage-badge');
    const noteText      = document.getElementById('note-text');
    const outputTitle   = document.getElementById('output-title');
    const countBadge    = document.getElementById('count-badge');
    const countScart    = document.getElementById('count-scartati');
    const tableBody     = document.getElementById('table-body');
    const scartatiBody  = document.getElementById('scartati-body');
    const sourceInfo    = document.getElementById('source-info');
    const errorSection  = document.getElementById('error-section');
    const errorMessage  = document.getElementById('error-message');

    const outputSection   = document.getElementById('output-section');
    const scartatiSection = document.getElementById('scartati-section');
    const legalNote       = document.getElementById('legal-note');
    const footerSection   = document.getElementById('footer-section');
    const proxyBadge      = document.getElementById('proxy-badge');

    /* ── MOSTRA BADGE PROXY (sempre attivo) ──────────────────── */
    if (proxyBadge) {
        proxyBadge.classList.remove('hidden');
    }

    /* ── AGENT CONFIG ─────────────────────────────────────────── */
    const DB_IDS = ['db-epo', 'db-uspto', 'db-wipo', 'db-cnipa'];

    const AGENTS = [
        {
            id: 'agent-1', defaultIcon: 'fa-sitemap',
            durationMs: 700, minDurationMs: 500,
            runningLabel: 'Avvio pipeline…'
        },
        {
            id: 'agent-2', defaultIcon: 'fa-database',
            durationMs: 0, minDurationMs: 2000, isDbAgent: true,
            runningLabel: 'Interrogazione database…'
        },
        {
            id: 'agent-3', defaultIcon: 'fa-scale-balanced',
            durationMs: 0, minDurationMs: 800,
            runningLabel: 'Classificazione brevetti…'
        },
        {
            id: 'agent-4', defaultIcon: 'fa-file-lines',
            durationMs: 0, minDurationMs: 600,
            runningLabel: 'Generazione report…'
        }
    ];

    /* ── STATE ────────────────────────────────────────────────── */
    let isRunning    = false;
    let currentData  = null;
    let dbBadgeTimers = [];  // IDs dei setTimeout badge DB — cancellati in caso di errore

    /* ── UTILS ────────────────────────────────────────────────── */
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const fadeToggle = (el, show) => {
        if (!el) return;
        if (show) {
            el.classList.remove('hidden');
            requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
        } else {
            el.classList.remove('visible');
            el.classList.add('hidden');
        }
    };

    /* ── TOKEN TOGGLE ─────────────────────────────────────────── */
    if (btnToggleToken) {
        btnToggleToken.addEventListener('click', () => {
            const isPassword = lensTokenEl.type === 'password';
            lensTokenEl.type = isPassword ? 'text' : 'password';
            iconEye.className = isPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        });
    }

    /* Aggiorna badge copertura e nota header quando l'utente incolla un token */
    if (lensTokenEl) {
        lensTokenEl.addEventListener('input', () => {
            const hasToken = lensTokenEl.value.trim().length > 0;
            if (coverageBadge) {
                coverageBadge.textContent  = hasToken ? '🌍 Copertura globale' : '🇺🇸 Solo USA';
                coverageBadge.className    = hasToken ? 'token-badge token-badge--global' : 'token-badge';
            }
            if (noteText) {
                noteText.innerHTML = hasToken
                    ? 'Fonti: <strong>Lens.org</strong> (EP · WO · US · CN · JP · +90 paesi) + <strong>USPTO PatentsView</strong>'
                    : 'Fonte: <strong>USPTO PatentsView</strong> — brevetti USA &nbsp;|&nbsp; Aggiungi token Lens.org per copertura globale';
            }
        });
    }

    /* ── AGENT STATE HELPERS ──────────────────────────────────── */
    const setAgentIdle = (el, agent) => {
        el.className = 'agent-card state-idle';
        el.querySelector('.state-icon').className = `fa-solid ${agent.defaultIcon} state-icon`;
        el.querySelector('.agent-status').textContent = 'In attesa';
        if (agent.isDbAgent) DB_IDS.forEach(id => {
            document.getElementById(id).className = 'db-badge';
        });
    };

    const setAgentRunning = (el, agent) => {
        el.className = 'agent-card state-running';
        el.querySelector('.state-icon').className = 'fa-solid fa-circle-notch fa-spin state-icon';
        el.querySelector('.agent-status').textContent = agent.runningLabel || 'In esecuzione…';
        if (agent.isDbAgent) {
            cancelDbTimers(); // annulla eventuali timer precedenti
            const step = 500;
            DB_IDS.forEach((id, i) => {
                const tid = setTimeout(() => {
                    document.getElementById(id).className = 'db-badge active';
                }, step * i);
                dbBadgeTimers.push(tid);
            });
        }
    };

    /**
     * Cancella tutti i setTimeout in sospeso per i badge del DB agent.
     * Va chiamata prima di qualsiasi transizione di stato che segue "running".
     */
    const cancelDbTimers = () => {
        dbBadgeTimers.forEach(id => clearTimeout(id));
        dbBadgeTimers = [];
    };

    const setAgentDone = (el, agent, label = 'Completato') => {
        cancelDbTimers();
        el.className = 'agent-card state-done';
        el.querySelector('.state-icon').className = 'fa-solid fa-circle-check state-icon';
        el.querySelector('.agent-status').textContent = label;
        if (agent.isDbAgent) DB_IDS.forEach(id => {
            document.getElementById(id).className = 'db-badge done';
        });
    };

    const setAgentError = (el, agent) => {
        cancelDbTimers(); // blocca immediatamente i badge in animazione
        el.className = 'agent-card state-error';
        el.querySelector('.state-icon').className = 'fa-solid fa-circle-xmark state-icon';
        el.querySelector('.agent-status').textContent = 'Errore';
        if (agent.isDbAgent) DB_IDS.forEach(id => {
            document.getElementById(id).className = 'db-badge error';
        });
    };

    /**
     * Esegue un agente: imposta stato "running", attende il task (reale o temporizzato),
     * poi imposta "done". Garantisce una durata minima di animazione visiva.
     */
    const runAgent = async (agent, task = null) => {
        const el  = document.getElementById(agent.id);
        setAgentRunning(el, agent);

        const t0  = Date.now();
        const min = agent.minDurationMs || 600;
        let result;

        try {
            result = task ? await task() : await sleep(agent.durationMs || 1000);
        } catch (err) {
            setAgentError(el, agent);
            throw err;
        }

        const elapsed = Date.now() - t0;
        if (elapsed < min) await sleep(min - elapsed);

        setAgentDone(el, agent);
        return result;
    };

    /* ═══════════════════════════════════════════════════════════
       LAYER 1 — RICERCA USPTO (PatentsView)
       Copertura: brevetti USA
    ═══════════════════════════════════════════════════════════ */

    /**
     * Costruisce il body per una singola query PatentsView v1.
     *
     * Nota campi v1:
     *   - patent_id             (non patent_number)
     *   - assignees.assignee_organization  (sotto-entità, non campo piatto)
     */
    const buildPatentsViewURL = (azienda, keywords) => {
        const q = JSON.stringify({ _and: [{ _text_any: { assignee_organization: azienda } }, { _text_any: { patent_title: keywords } }] });
        const f = JSON.stringify(['patent_id','patent_title','patent_date','assignees.assignee_organization']);
        const o = JSON.stringify({ per_page: 25 });
        const s = JSON.stringify([{ patent_date: 'desc' }]);
        return `${PATENTSVIEW_URL}?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&o=${encodeURIComponent(o)}&s=${encodeURIComponent(s)}`;
    };
    const buildPatentsViewQuery = (azienda, keywords) => ({
        q: {
            _and: [
                { _text_any: { assignee_organization: azienda } },
                { _text_any: { patent_title: keywords } }
            ]
        },
        f: [
            'patent_id',
            'patent_title',
            'patent_date',
            'assignees.assignee_organization'
        ],
        o: { per_page: 25 },
        s: [{ patent_date: 'desc' }]
    });

    /**
     * Esegue 3 query su USPTO PatentsView e restituisce patent objects normalizzati.
     * Resiliente ai nomi di campo sia della v1 (patent_id, assignees[])
     * che dell’eventuale vecchia v0 (patent_number, assignee_organization flat).
     *
     * @param {string} azienda
     * @param {string} prodotto
     * @returns {Promise<NormalizedPatent[]>}
     */
    const searchUSPTO = async (azienda, prodotto) => {
        const termsList = [
            prodotto || 'heat exchanger',
            'heat exchanger',
            'plate heat exchanger'
        ];

        const seen = new Map();
        let lastError = null;

        for (const terms of termsList) {
            try {
                const resp = await proxyFetch(buildPatentsViewURL(azienda, terms), {
                    method: 'GET'
                });

                if (!resp.ok) {
                    const txt = await resp.text().catch(() => '');
                    console.warn(`[USPTO] HTTP ${resp.status}:`, txt.slice(0, 200));
                    lastError = `USPTO HTTP ${resp.status}`;
                    continue;
                }

                const data = await resp.json();
                console.log(`[USPTO] Trovati ${(data.patents || []).length} brevetti per "${terms}"`);

                (data.patents || []).forEach(p => {
                    /* Campi v1: patent_id (es. "US12345678B2") */
                    const rawId  = p.patent_id || p.patent_number || '';
                    if (!rawId || seen.has(rawId)) return;

                    /* Normalizza numero: assicura prefisso US */
                    const numero = rawId.startsWith('US') ? rawId : `US${rawId}`;

                    /* Assignee: v1 usa array assignees[], v0 usava campo piatto */
                    const assignees  = Array.isArray(p.assignees) ? p.assignees : [];
                    const assigneeOrg = assignees.length > 0
                        ? (assignees[0].assignee_organization || '').trim()
                        : (p.assignee_organization || '').trim();

                    seen.set(rawId, {
                        id:       numero,
                        numero,
                        titolo:   p.patent_title  || '',
                        data:     p.patent_date   || '',
                        assignee: assigneeOrg,
                        source:   'USPTO'
                    });
                });
            } catch (e) {
                console.warn(`[USPTO] Errore query "${terms}":`, e.message);
                lastError = e.message;
            }
        }

        if (seen.size === 0 && lastError) throw new Error(lastError);
        return Array.from(seen.values());
    };

    /* ═══════════════════════════════════════════════════════════
       LAYER 2 — RICERCA LENS.ORG (copertura globale)
       Copertura: US, EP, WO, CN, JP, + 90 paesi
    ═══════════════════════════════════════════════════════════ */

    /**
     * Costruisce il body per una singola query Lens.org.
     */
    const buildLensQuery = (azienda, keywords, size = 50) => ({
        query: {
            bool: {
                must: [
                    { match: { 'applicant.name': azienda } },
                    {
                        bool: {
                            should: [
                                { match: { title: keywords } },
                                { match: { 'claim.text': keywords } }
                            ]
                        }
                    }
                ]
            }
        },
        size,
        sort: [{ 'date_published': 'desc' }],
        include: [
            'lens_id', 'publication_number', 'jurisdiction',
            'title', 'date_published', 'applicant',
            'legal_status', 'expiry_date', 'abstract'
        ]
    });

    /**
     * Esegue 3 query su Lens.org e restituisce un array di patent objects normalizzati.
     *
     * @param {string} azienda
     * @param {string} prodotto
     * @param {string} token    - Lens.org bearer token
     * @returns {Promise<NormalizedPatent[]>}
     */
    const searchLens = async (azienda, prodotto, token) => {
        const termsList = [
            prodotto || 'heat exchanger',
            'heat exchanger',
            'plate heat exchanger'
        ];

        const seen = new Map();
        let lastError = null;

        for (const terms of termsList) {
            try {
                const resp = await proxyFetch(LENS_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(buildLensQuery(azienda, terms))
                });

                if (resp.status === 401) throw new Error('Token Lens.org non valido o scaduto. Verifica il token su lens.org.');
                if (resp.status === 429) throw new Error('Limite di richieste Lens.org superato. Riprova tra qualche minuto.');
                if (!resp.ok) { lastError = `Lens.org HTTP ${resp.status}`; continue; }

                const data = await resp.json();
                (data.data || []).forEach(p => {
                    const num = p.publication_number || p.lens_id || '';
                    if (!num || seen.has(num)) return;

                    /* Estrai applicant name */
                    const applicants = p.applicant || [];
                    const assigneeName = applicants.map(a => a.name || '').filter(Boolean).join('; ');

                    /* Estrai titolo (può essere array o stringa) */
                    let titolo = '';
                    if (Array.isArray(p.title)) {
                        titolo = (p.title.find(t => t.lang === 'en') || p.title[0] || {}).text || '';
                    } else {
                        titolo = p.title || '';
                    }

                    /* Stato legale */
                    let statoLens = 'Da verificare';
                    if (p.legal_status) {
                        const ls = p.legal_status.toLowerCase();
                        if (ls.includes('active') || ls.includes('granted'))  statoLens = 'Attivo';
                        else if (ls.includes('lapsed') || ls.includes('expired')) statoLens = 'Scaduto';
                        else if (ls.includes('pending') || ls.includes('filed'))  statoLens = 'In esame';
                    }

                    /* Scadenza */
                    let scadenza;
                    if (p.expiry_date) {
                        scadenza = p.expiry_date.slice(0, 4); // anno YYYY
                    }

                    seen.set(num, {
                        id:         num,
                        numero:     num,
                        titolo,
                        data:       p.date_published || '',
                        assignee:   assigneeName,
                        abstract:   '',
                        giurisdizione: p.jurisdiction || '',
                        statoLens,
                        scadenza,
                        source:     'Lens'
                    });
                });
            } catch (e) {
                if (e.message.includes('Token') || e.message.includes('Limite')) throw e;
                lastError = e.message;
            }
        }

        if (seen.size === 0 && lastError) throw new Error(`Lens.org: ${lastError}`);
        return Array.from(seen.values());
    };

    /* ═══════════════════════════════════════════════════════════
       LAYER 3 — CLASSIFICAZIONE
    ═══════════════════════════════════════════════════════════ */

    const PATENT_LIFETIME_YEARS = 20;

    /**
     * Stima lo stato di un brevetto USPTO dalla data di concessione.
     * Regola semplificata: US utility patent = 20 anni dalla concessione.
     */
    const estimateStatus = (dateStr) => {
        if (!dateStr) return { stato: 'Da verificare', scadenza: null };
        const grantDate = new Date(dateStr);
        const ageYears  = (Date.now() - grantDate.getTime()) / (365.25 * 24 * 3600 * 1000);
        if (ageYears > PATENT_LIFETIME_YEARS) return { stato: 'Scaduto', scadenza: null };
        return {
            stato:    'Attivo',
            scadenza: String(grantDate.getFullYear() + PATENT_LIFETIME_YEARS)
        };
    };

    /**
     * Estrae una breve etichetta tecnologica dal titolo del brevetto.
     */
    const extractTechnology = (titolo, azienda) => {
        if (!titolo) return '—';
        return titolo
            .replace(new RegExp(`\\b${azienda}\\b`, 'gi'), '')
            .replace(/\s+/g, ' ')
            .trim()
            .split(/\s+/)
            .slice(0, 7)
            .join(' ') || titolo.split(/\s+/).slice(0, 7).join(' ');
    };

    /**
     * Classifica l'insieme grezzo di brevetti (da una o più fonti)
     * in "conformi" e "scartati".
     *
     * @param {NormalizedPatent[]} patents
     * @param {string}             azienda
     * @returns {{ conformi: Patent[], scartati: Scartato[] }}
     */
    const classifyPatents = (patents, azienda) => {
        const conformi = [];
        const scartati = [];
        const aziendaLc = azienda.toLowerCase();

        patents.forEach(p => {
            /* ── SCARTO: assignee non corrisponde ── */
            if (p.assignee && !p.assignee.toLowerCase().includes(aziendaLc)) {
                scartati.push({ numero: p.numero, motivo: `Assignee diverso: "${p.assignee}"` });
                return;
            }

            let stato, scadenza, giurisdizione;

            if (p.source === 'Lens') {
                /* Lens.org fornisce stato legale e giurisdizione direttamente */
                stato         = p.statoLens || 'Da verificare';
                scadenza      = p.scadenza  || null;
                giurisdizione = labelJurisdiction(p.giurisdizione);

                /* Scarta brevetti scaduti da Lens */
                if (stato === 'Scaduto') {
                    scartati.push({ numero: p.numero, motivo: 'Scaduto (stato legale Lens.org)' });
                    return;
                }
            } else {
                /* USPTO: stima stato dalla data di concessione */
                const estimate = estimateStatus(p.data);
                stato    = estimate.stato;
                scadenza = estimate.scadenza;
                giurisdizione = labelJurisdiction('US');

                if (stato === 'Scaduto') {
                    scartati.push({ numero: p.numero, motivo: `Scaduto (concessione ${p.data}, >20 anni)` });
                    return;
                }
            }

            conformi.push({
                numero:       p.numero,
                tecnologia:   extractTechnology(p.titolo, azienda),
                giurisdizione,
                stato,
                assignee:     p.assignee || azienda,
                scadenza
            });
        });

        /* Ordina: EP/WO prima, poi US */
        conformi.sort((a, b) => {
            const priority = str => str.includes('EPO') ? 0 : str.includes('PCT') ? 1 : 2;
            return priority(a.giurisdizione) - priority(b.giurisdizione);
        });

        return { conformi, scartati };
    };

    /* ═══════════════════════════════════════════════════════════
       RENDER
    ═══════════════════════════════════════════════════════════ */

    const buildBadge = (stato, scadenza) => {
        const span = document.createElement('span');
        span.className = 'badge';
        const s = (stato || '').toLowerCase();
        if (s.includes('attivo')) {
            span.classList.add('badge-attivo');
            span.textContent = scadenza ? `Attivo — scad. ${scadenza}` : 'Attivo';
        } else if (s.includes('scaduto')) {
            span.classList.add('badge-scaduto');
            span.textContent = 'Scaduto';
        } else if (s.includes('esame') || s.includes('pending')) {
            span.classList.add('badge-esame');
            span.textContent = 'In esame';
        } else {
            span.classList.add('badge-verifica');
            span.textContent = stato || 'Da verificare';
        }
        return span;
    };

    const renderResults = (data, sources, totalFound) => {
        currentData = data;
        const { conformi = [], scartati = [] } = data;

        /* Fonte */
        if (sourceInfo) {
            sourceInfo.textContent = `${sources.join(' + ')} — ${totalFound} brevetti analizzati`;
        }

        /* Brevetti conformi */
        tableBody.innerHTML = '';
        if (conformi.length === 0) {
            tableBody.innerHTML = `<tr class="empty-row"><td colspan="5" class="empty-cell">
                <i class="fa-regular fa-folder-open"></i>
                Nessun brevetto conforme trovato per questa ricerca</td></tr>`;
        } else {
            conformi.forEach(b => {
                const tr     = document.createElement('tr');
                const tdNum  = document.createElement('td');
                const link   = Object.assign(document.createElement('a'), {
                    className: 'patent-link',
                    textContent: b.numero,
                    href:   `https://patents.google.com/patent/${b.numero.replace(/\s+/g, '')}`,
                    target: '_blank',
                    rel:    'noopener noreferrer'
                });
                tdNum.appendChild(link);

                const tdTech  = Object.assign(document.createElement('td'), { textContent: b.tecnologia || '—' });
                const tdLuogo = Object.assign(document.createElement('td'), { textContent: b.giurisdizione || '—' });
                const tdStato = document.createElement('td');
                tdStato.appendChild(buildBadge(b.stato, b.scadenza));
                const tdAz    = Object.assign(document.createElement('td'), { textContent: b.assignee || '—' });

                tr.append(tdNum, tdTech, tdLuogo, tdStato, tdAz);
                tableBody.appendChild(tr);
            });
        }
        countBadge.textContent = `${conformi.length} brevett${conformi.length === 1 ? 'o' : 'i'}`;

        /* Brevetti scartati */
        scartatiBody.innerHTML = '';
        if (scartati.length === 0) {
            scartatiBody.innerHTML = `<tr class="empty-row"><td colspan="2" class="empty-cell">
                <i class="fa-regular fa-circle-check"></i> Nessun brevetto escluso</td></tr>`;
        } else {
            scartati.forEach(b => {
                const tr  = document.createElement('tr');
                const tdN = Object.assign(document.createElement('td'), {
                    className: 'patent-link', textContent: b.numero || '—'
                });
                const tdM = Object.assign(document.createElement('td'), { textContent: b.motivo || '—' });
                tr.append(tdN, tdM);
                scartatiBody.appendChild(tr);
            });
        }
        countScart.textContent = `${scartati.length} escl${scartati.length === 1 ? 'uso' : 'usi'}`;
    };

    /* ── AVVISO NON BLOCCANTE (es. una fonte su due fallisce) ───── */
    const showWarning = msg => {
        if (errorMessage) errorMessage.textContent = msg;
        fadeToggle(errorSection, true);
        // Non tocca isRunning né btnAvvia: la pipeline prosegue
    };

    /* ── ERRORE FATALE: ferma pipeline + riabilita UI ────────────── */
    const showError = msg => {
        if (errorMessage) errorMessage.textContent = msg;
        fadeToggle(errorSection, true);
    };

    /**
     * Porta tutti gli agenti ancora in stato "running" allo stato "errore".
     * Chiamato ogni volta che la pipeline si interrompe prima del completamento.
     */
    const abortPipeline = () => {
        AGENTS.forEach(agent => {
            const el = document.getElementById(agent.id);
            if (el && el.classList.contains('state-running')) {
                setAgentError(el, agent);
            }
        });
    };

    /* ═══════════════════════════════════════════════════════════
       PIPELINE PRINCIPALE
    ═══════════════════════════════════════════════════════════ */
    const startSequence = async () => {
        if (isRunning) return;
        isRunning = true;

        const azienda   = aziendaEl.value.trim() || 'N/D';
        const prodotto  = prodottoEl.value.trim() || '';
        const token     = lensTokenEl ? lensTokenEl.value.trim() : '';
        const useGlobal = token.length > 0;

        btnAvvia.disabled = true;
        outputTitle.textContent = `${azienda}${prodotto ? ' — ' + prodotto : ''}`;

        [outputSection, scartatiSection, legalNote, footerSection, errorSection].forEach(el => {
            fadeToggle(el, false);
        });

        try {
            /* ── AGENT 1: Orchestratore ─────────────────────────── */
            await runAgent(AGENTS[0]);

            /* ── AGENT 2: Ricerca reale ─────────────────────────── */
            const el2     = document.getElementById(AGENTS[1].id);
            const t2start = Date.now();
            setAgentRunning(el2, AGENTS[1]);

            let allPatents = [];
            const sources  = [];
            const warnings = [];

            if (useGlobal) {
                const [usptoResult, lensResult] = await Promise.allSettled([
                    searchUSPTO(azienda, prodotto),
                    searchLens(azienda, prodotto, token)
                ]);

                if (usptoResult.status === 'fulfilled') {
                    allPatents.push(...usptoResult.value);
                    sources.push('USPTO PatentsView');
                } else {
                    warnings.push(`USPTO: ${usptoResult.reason.message}`);
                }

                if (lensResult.status === 'fulfilled') {
                    const usptoNums = new Set(allPatents.map(p => p.numero));
                    const lensUniq  = lensResult.value.filter(p => !usptoNums.has(p.numero));
                    allPatents.push(...lensUniq);
                    sources.push('Lens.org');
                } else {
                    warnings.push(`Lens.org: ${lensResult.reason.message}`);
                }

                // ── ERRORE FATALE: entrambe le fonti irraggiungibili ──
                if (sources.length === 0) {
                    // Nessun sleep: l'agente diventa rosso e l'errore appare subito
                    setAgentError(el2, AGENTS[1]);
                    abortPipeline();
                    showError(`Nessuna fonte raggiungibile — ${warnings.join(' | ')}`);
                    return; // ◄── pipeline interrotta
                }

                // ── AVVISO non bloccante: solo una fonte ha risposto ──
                if (warnings.length > 0) {
                    showWarning(
                        `⚠️ Fonte parziale — ${warnings.join(' | ')}` +
                        ` | Risultati da: ${sources.join(' + ')}`
                    );
                }

            } else {
                // Solo USPTO — errore fatale se non risponde
                try {
                    allPatents = await searchUSPTO(azienda, prodotto);
                    sources.push('USPTO PatentsView');
                } catch (err) {
                    // Nessun sleep: l'agente diventa rosso e l'errore appare subito
                    setAgentError(el2, AGENTS[1]);
                    abortPipeline();
                    showError(`USPTO non raggiungibile: ${err.message}`);
                    return; // ◄── pipeline interrotta
                }
            }

            // Durata minima animazione
            const elapsed2 = Date.now() - t2start;
            if (elapsed2 < (AGENTS[1].minDurationMs || 2000))
                await sleep((AGENTS[1].minDurationMs || 2000) - elapsed2);
            setAgentDone(el2, AGENTS[1],
                `${allPatents.length} trovati · ${sources.join(' + ')}`);

            /* ── AGENT 3: Verifica ──────────────────────────────── */
            const verified = await runAgent(
                AGENTS[2],
                () => classifyPatents(allPatents, azienda)
            );
            setAgentDone(
                document.getElementById(AGENTS[2].id), AGENTS[2],
                `${verified.conformi.length} conformi · ${verified.scartati.length} scartati`
            );

            /* ── AGENT 4: Reporting ─────────────────────────────── */
            await runAgent(AGENTS[3], async () => {
                renderResults(verified, sources, allPatents.length);
            });

            [outputSection, scartatiSection, legalNote, footerSection].forEach(el => {
                fadeToggle(el, true);
            });

        } catch (err) {
            // Errore imprevisto non catturato nei blocchi specifici
            console.error('[Ricerca Brevetti] Errore imprevisto:', err);
            abortPipeline();
            showError(`Errore imprevisto: ${err.message}`);

        } finally {
            // Garanzia assoluta: il pulsante è sempre riabilitato a fine corsa
            btnAvvia.disabled = false;
            isRunning = false;
        }
    };

    /* ── RESET ─────────────────────────────────────────────────── */
    const resetUI = () => {
        isRunning   = false;
        currentData = null;
        btnAvvia.disabled = false;

        AGENTS.forEach(agent => setAgentIdle(document.getElementById(agent.id), agent));

        [outputSection, scartatiSection, legalNote, footerSection, errorSection].forEach(el => {
            fadeToggle(el, false);
        });

        tableBody.innerHTML = `<tr class="empty-row"><td colspan="5" class="empty-cell">
            <i class="fa-regular fa-folder-open"></i>
            Nessun dato disponibile — avvia una ricerca per popolare la tabella</td></tr>`;
        scartatiBody.innerHTML = `<tr class="empty-row"><td colspan="2" class="empty-cell">
            <i class="fa-regular fa-circle-check"></i> Nessun brevetto escluso</td></tr>`;
        countBadge.textContent = '0 brevetti';
        countScart.textContent = '0 esclusi';
        if (sourceInfo) sourceInfo.textContent = '';
    };

    /* ── CSV EXPORT ─────────────────────────────────────────────── */
    const exportCSV = () => {
        if (!currentData) return;
        const { conformi = [], scartati = [] } = currentData;
        const q = v => `"${(v || '').replace(/"/g, '""')}"`;

        let csv = 'N° Brevetto,Tecnologia,Giurisdizione,Stato,Azienda,Scadenza stimata\n';
        conformi.forEach(b => {
            csv += [b.numero, b.tecnologia, b.giurisdizione, b.stato, b.assignee, b.scadenza || '']
                .map(q).join(',') + '\n';
        });
        if (scartati.length > 0) {
            csv += '\n\nN° Brevetto (scartati),Motivo esclusione\n';
            scartati.forEach(b => { csv += `${q(b.numero)},${q(b.motivo)}\n`; });
        }

        const a = Object.assign(document.createElement('a'), {
            href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })),
            download: `brevetti_${(aziendaEl.value || 'export').trim()}.csv`,
            style:    'display:none'
        });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    /* ── EVENTS ─────────────────────────────────────────────────── */
    btnAvvia.addEventListener('click', startSequence);
    btnReset.addEventListener('click', resetUI);
    btnExport.addEventListener('click', exportCSV);
    [aziendaEl, prodottoEl].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') startSequence(); });
    });
});
