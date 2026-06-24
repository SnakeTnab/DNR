// ==UserScript==
// @name         DNR Auto-Submit FR-TNAB-DWP1
// @namespace    https://github.com/snake83910
// @version      1.0.0
// @description  Récupère automatiquement le rapport DNR_Investigations, applique le mapping par défaut et l'envoie via un backend SMTP. Poll automatique + déclenchement manuel via menu Tampermonkey.
// @author       Remy
// @match        https://logistics.amazon.fr/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      logistics.amazon.fr
// @connect      flex-peer-performance-reports-prod-euamazon.s3.eu-west-1.amazonaws.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // =====================================================================
  // CONFIGURATION (modifiable via le menu Tampermonkey)
  // =====================================================================
  const CONFIG = {
    DSP: 'TNAB',
    STATION: 'DWP1',
    BACKEND_URL: GM_getValue('backend_url', 'https://dnr-backend.onrender.com/dnr/submit'),
    API_KEY: GM_getValue('api_key', ''),
    POLL_INTERVAL_MIN: 30, // toutes les 30 minutes
    INITIAL_DELAY_MS: 5000, // attendre 5s après chargement de page avant 1er run
    DEBUG: GM_getValue('debug', false),
  };

  // =====================================================================
  // MAPPING par défaut : Delivery Scan -> réponses du formulaire
  // Modifier les valeurs ici selon les retours d'expérience.
  // Les codes valides correspondent à ceux du HTML Amazon
  // (DELIVERY_OPTIONS_FIRST / _SECOND / _THIRD / PROPERTY_TYPES).
  // =====================================================================
  const SCAN_MAPPING = {
    // Remise en main propre / membre du foyer
    DELIVERED_TO_HOUSEHOLD_MEMBER: {
      completion: 'CUSTOMER_HHM',
      location: 'HHM',
      additional: 'DOOR_STEP',
      property: 'APARTMENT_BLOCK',
    },
    DELIVERED_TO_CUSTOMER: {
      completion: 'CUSTOMER_HHM',
      location: 'CUSTOMER',
      additional: 'DOOR_STEP',
      property: 'APARTMENT_BLOCK',
    },
    HANDED_TO_RESIDENT: {
      completion: 'CUSTOMER_HHM',
      location: 'CUSTOMER',
      additional: 'DOOR_STEP',
      property: 'APARTMENT_BLOCK',
    },

    // Boîte aux lettres
    DELIVERED_TO_MAIL_SLOT: {
      completion: 'SAFE_PLACE',
      location: 'MAILBOX',
      additional: 'MAILBOX',
      property: 'APARTMENT_BLOCK',
    },

    // Lieu sûr / porte d'entrée
    DELIVERED_TO_SAFE_LOCATION: {
      completion: 'SAFE_PLACE',
      location: 'FRONT_DOOR',
      additional: 'FRONT',
      property: 'HOUSE',
    },

    // Voisin / réceptionniste / gardien
    DELIVERED_TO_NEIGHBOUR: {
      completion: 'ALTERNATIVE',
      location: 'NEIGHBOUR',
      additional: 'SAME_FLOOR',
      property: 'APARTMENT_BLOCK',
    },
    DELIVERED_TO_RECEPTIONIST: {
      completion: 'ALTERNATIVE',
      location: 'RECEPTIONIST',
      additional: 'IN_BUILDING',
      property: 'OFFICE',
    },
    DELIVERED_TO_BUILDING_MANAGER: {
      completion: 'ALTERNATIVE',
      location: 'CARETAKER',
      additional: 'IN_BUILDING',
      property: 'APARTMENT_BLOCK',
    },

    // Locker / point relais (rare en DSP, mais on couvre)
    DELIVERED_TO_LOCKER: {
      completion: 'LOCKER',
      location: 'AMZN_LOCKER',
      additional: '',
      property: 'APARTMENT_BLOCK',
    },

    // Fallback - en cas de scan inconnu, on prend la valeur la plus neutre
    DEFAULT: {
      completion: 'SAFE_PLACE',
      location: 'FRONT_DOOR',
      additional: 'FRONT',
      property: 'APARTMENT_BLOCK',
    },
  };

  // =====================================================================
  // UTILITAIRES
  // =====================================================================
  const log = (...args) => console.log('[DNR-Auto]', ...args);
  const warn = (...args) => console.warn('[DNR-Auto]', ...args);
  const err = (...args) => console.error('[DNR-Auto]', ...args);

  function notify(text, title = 'DNR Auto-Submit', timeout = 5000) {
    try {
      GM_notification({ title, text, timeout });
    } catch (_) {
      // Pas grave si la notif échoue
    }
    log(`[NOTIFY] ${title}: ${text}`);
  }

  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        headers: opts.headers || {},
        data: opts.data,
        responseType: opts.responseType || 'text',
        onload: (r) => resolve(r),
        onerror: (e) => reject(new Error(`Network error: ${e.error || 'unknown'}`)),
        ontimeout: () => reject(new Error('Timeout')),
        timeout: opts.timeout || 30000,
      });
    });
  }

  // Calcul du numéro de semaine ISO 8601 (la semaine 1 contient le jeudi 4 janvier)
  function getISOWeek(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNum };
  }

  function formatWeek({ year, week }) {
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  // =====================================================================
  // 1) Récupérer l'index des rapports de la semaine via l'API
  // =====================================================================
  async function fetchReportIndex() {
    const week = formatWeek(getISOWeek());
    const url =
      `https://logistics.amazon.fr/performance/api/v1/getData` +
      `?dataSetId=dsp_station_weekly_supp_reports` +
      `&dsp=${CONFIG.DSP}` +
      `&from=${week}` +
      `&station=${CONFIG.STATION}` +
      `&timeFrame=Weekly` +
      `&to=${week}`;

    log('Fetch index:', url);
    const resp = await gmFetch(url);
    if (resp.status !== 200) {
      throw new Error(`Index API status ${resp.status}`);
    }
    const data = JSON.parse(resp.responseText);
    const rows = data.tableData?.dsp_station_weekly_supp_reports?.rows || [];
    return rows.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
  }

  // =====================================================================
  // 2) Trouver et télécharger le dernier rapport DNR
  // =====================================================================
  async function fetchLatestDNR(reports) {
    const dnrReports = reports
      .filter((r) => r.name && r.name.startsWith('DNR_Investigations'))
      .sort((a, b) => (b.formattedCreationDate || '').localeCompare(a.formattedCreationDate || ''));

    if (dnrReports.length === 0) {
      log('Pas de rapport DNR cette semaine');
      return null;
    }

    const dnr = dnrReports[0];
    const lastSent = GM_getValue('last_sent_creationDate', '');
    if (dnr.formattedCreationDate === lastSent) {
      log('DNR déjà traité (creationDate identique):', lastSent);
      return { skip: true, dnr };
    }

    log('Téléchargement du DNR:', dnr.name, dnr.formattedCreationDate);
    const resp = await gmFetch(dnr.downloadUrl);
    if (resp.status !== 200) {
      throw new Error(`S3 status ${resp.status} pour ${dnr.name}`);
    }
    return { html: resp.responseText, dnr };
  }

  // =====================================================================
  // 3) Parser le HTML et générer les entrées
  // =====================================================================
  function parseAndFill(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = doc.querySelectorAll('tbody > tr[data-dsp-action]');
    const entries = [];
    const skippedScans = new Set();

    rows.forEach((tr, idx) => {
      const tracking_id = tr.querySelector('input[name=tracking_id]')?.value || '';
      const order_id = tr.querySelector('input[name=order_id]')?.value || '';
      const marketplace_id = tr.querySelector('input[name=marketplace_id]')?.value || '';
      const case_datetime = tr.querySelector('input[name=case_datetime]')?.value || '';

      // Le Delivery Scan est dans la 4e colonne (index 3)
      const tds = tr.querySelectorAll('td');
      const deliveryScan = (tds[3]?.textContent || '').trim();

      const mapping = SCAN_MAPPING[deliveryScan] || SCAN_MAPPING.DEFAULT;
      if (!SCAN_MAPPING[deliveryScan]) {
        skippedScans.add(deliveryScan || '(vide)');
        warn(`Scan inconnu "${deliveryScan}" pour ${tracking_id} -> mapping DEFAULT appliqué`);
      }

      entries.push({
        tracking_id,
        order_id,
        marketplace_id,
        case_datetime,
        completion: mapping.completion,
        location: mapping.location,
        additional: mapping.additional,
        property: mapping.property,
        building_number: '',
        building_floor: '',
      });

      if (CONFIG.DEBUG) {
        log(`#${idx + 1} ${tracking_id} | scan=${deliveryScan} | -> ${JSON.stringify(mapping)}`);
      }
    });

    if (skippedScans.size > 0) {
      warn('Scans non mappés (mapping DEFAULT utilisé):', [...skippedScans]);
    }

    return entries;
  }

  // =====================================================================
  // 4) Générer le payload base64 EXACTEMENT comme regenerateData() du HTML
  //    Le HTML fait :
  //    btoa(String.fromCharCode(...(new TextEncoder().encode(JSON.stringify(...)))))
  // =====================================================================
  function generateB64(entries) {
    const json = JSON.stringify({ version: 1, data: entries });
    const utf8Bytes = new TextEncoder().encode(json);
    // String.fromCharCode(...bytes) ne marche pas pour > ~65k bytes (call stack)
    // donc on construit caractère par caractère pour être robuste
    let binary = '';
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    return btoa(binary);
  }

  // =====================================================================
  // 5) Envoyer au backend
  // =====================================================================
  async function sendToBackend(b64, entries, dnrMeta) {
    if (!CONFIG.BACKEND_URL || !CONFIG.API_KEY) {
      throw new Error('BACKEND_URL ou API_KEY non configurés. Menu Tampermonkey -> "DNR: Set backend URL / API key"');
    }

    const body = {
      dsp: CONFIG.DSP,
      station: CONFIG.STATION,
      data_b64: b64,
      tracking_ids: entries.map((e) => e.tracking_id),
      report_creation_date: dnrMeta.formattedCreationDate,
      report_name: dnrMeta.name,
      cases_count: entries.length,
    };

    log('POST -> backend:', CONFIG.BACKEND_URL, '(', entries.length, 'cases )');
    const resp = await gmFetch(CONFIG.BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.API_KEY,
      },
      data: JSON.stringify(body),
      timeout: 60000,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Backend HTTP ${resp.status}: ${resp.responseText}`);
    }
    return JSON.parse(resp.responseText);
  }

  // =====================================================================
  // WORKFLOW PRINCIPAL
  // =====================================================================
  let running = false;

  async function runWorkflow(manual = false) {
    if (running) {
      log('Cycle déjà en cours, skip');
      return;
    }
    running = true;
    try {
      log('=== Début cycle DNR Auto-Submit ===');
      const reports = await fetchReportIndex();
      const result = await fetchLatestDNR(reports);

      if (!result) {
        if (manual) notify('Pas de rapport DNR cette semaine');
        return;
      }
      if (result.skip) {
        if (manual) notify(`Déjà traité (${result.dnr.formattedCreationDate})`);
        return;
      }

      const entries = parseAndFill(result.html);
      if (entries.length === 0) {
        notify('Rapport DNR vide (0 case)');
        GM_setValue('last_sent_creationDate', result.dnr.formattedCreationDate);
        return;
      }

      const b64 = generateB64(entries);
      const response = await sendToBackend(b64, entries, result.dnr);

      GM_setValue('last_sent_creationDate', result.dnr.formattedCreationDate);
      GM_setValue('last_sent_count', entries.length);
      GM_setValue('last_sent_at', new Date().toISOString());
      GM_setValue('last_sent_tracking_ids', JSON.stringify(entries.map((e) => e.tracking_id)));

      notify(`✅ ${entries.length} case(s) envoyée(s)`, 'DNR Auto-Submit');
      log('Backend response:', response);
    } catch (e) {
      err('Erreur dans le cycle:', e);
      notify(`❌ Erreur: ${e.message}`, 'DNR Auto-Submit Error', 10000);
    } finally {
      running = false;
      log('=== Fin cycle ===');
    }
  }

  // =====================================================================
  // SCHEDULING
  // =====================================================================
  setTimeout(() => runWorkflow(false), CONFIG.INITIAL_DELAY_MS);
  setInterval(() => runWorkflow(false), CONFIG.POLL_INTERVAL_MIN * 60 * 1000);

  // =====================================================================
  // MENU TAMPERMONKEY (déclenchement et config manuels)
  // =====================================================================
  try {
    GM_registerMenuCommand('▶ Run now', () => runWorkflow(true));
    GM_registerMenuCommand('🔁 Reset last sent (force re-send)', () => {
      GM_setValue('last_sent_creationDate', '');
      alert('Reset effectué. Le prochain cycle renverra le dernier rapport.');
    });
    GM_registerMenuCommand('⚙ Configurer Backend URL', () => {
      const url = prompt('Backend URL (ex: https://dnr-backend.onrender.com/dnr/submit)', CONFIG.BACKEND_URL);
      if (url) {
        GM_setValue('backend_url', url);
        CONFIG.BACKEND_URL = url;
        alert('Backend URL sauvegardé. Recharger la page pour appliquer.');
      }
    });
    GM_registerMenuCommand('🔑 Configurer API Key', () => {
      const k = prompt('API Key (doit matcher celle du backend)', CONFIG.API_KEY);
      if (k !== null) {
        GM_setValue('api_key', k);
        CONFIG.API_KEY = k;
        alert('API Key sauvegardée. Recharger la page pour appliquer.');
      }
    });
    GM_registerMenuCommand('📊 Status', () => {
      const last_at = GM_getValue('last_sent_at', 'jamais');
      const last_count = GM_getValue('last_sent_count', 0);
      const last_date = GM_getValue('last_sent_creationDate', '—');
      alert(
        `DNR Auto-Submit Status\n\n` +
          `Dernier envoi: ${last_at}\n` +
          `Cases envoyées: ${last_count}\n` +
          `Rapport (creationDate): ${last_date}\n\n` +
          `Backend: ${CONFIG.BACKEND_URL}\n` +
          `API Key: ${CONFIG.API_KEY ? '(configurée)' : '(non configurée)'}\n` +
          `Poll: toutes les ${CONFIG.POLL_INTERVAL_MIN} min`
      );
    });
    GM_registerMenuCommand('🐛 Toggle DEBUG', () => {
      const newVal = !CONFIG.DEBUG;
      GM_setValue('debug', newVal);
      CONFIG.DEBUG = newVal;
      alert(`DEBUG = ${newVal}`);
    });
  } catch (e) {
    warn('GM_registerMenuCommand non disponible:', e);
  }

  log('DNR Auto-Submit chargé. Backend:', CONFIG.BACKEND_URL);
})();
