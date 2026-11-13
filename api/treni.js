const VT_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
const DAY_MS = 24 * 3600000;

function vtDate(d) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    weekday: "short", month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "longOffset"
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const off = (parts.timeZoneName || "GMT+01:00").replace(":", "");
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${off}`;
}

function romeMidnight(d) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = localAsUtc - Math.floor(d.getTime() / 1000) * 1000;
  return Date.UTC(+p.year, +p.month - 1, +p.day) - offset;
}

function pretty(name) {
  return String(name || "").toLowerCase().replace(/(^|[\s'.-])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
}

const EXCLUDED_CATS = new Set(["FR", "FA", "FB", "ITA"]);

const STATION_NAMES = {
  S01810: "Tortona",
  S01820: "Milano Rogoredo",
  S01701: "Milano Lambrate",
  S01492: "Milano Forlanini",
  S01700: "Milano Centrale",
  S01645: "Milano P. Garibaldi",
  S01642: "Milano P. Garibaldi",
  S01322: "Milano Greco Pirelli",
  S01707: "Cassano d'Adda",
  S01708: "Treviglio"
};

function matchStation(stopId, targetId) {
  if (stopId === targetId) return true;
  if (targetId === "S01645" && stopId === "S01642") return true;
  if (targetId === "S01642" && stopId === "S01645") return true;
  return false;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14)" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14)" },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Estrae i dati di una tratta riallineando automaticamente il giorno rispetto alla finestra richiesta [refStart, refEnd]
function extractLeg(andamento, summary, stationA, stationB, refStart, refEnd, nowMs) {
  if (!andamento || !Array.isArray(andamento.fermate)) return null;

  const idxA = andamento.fermate.findIndex((f) => matchStation(f.id, stationA));
  const idxB = andamento.fermate.findIndex((f) => matchStation(f.id, stationB));
  if (idxA === -1 || idxB === -1 || idxA >= idxB) return null;

  const stopA = andamento.fermate[idxA];
  const stopB = andamento.fermate[idxB];

  const rawDepSched = stopA.partenza_teorica || stopA.programmata;
  const rawArrSched = stopB.arrivo_teorico || stopB.programmata;
  if (!rawDepSched || !rawArrSched) return null;

  let durMs = rawArrSched - rawDepSched;
  if (durMs < 0) durMs += DAY_MS;

  // Calcola di quanti giorni traslare l'orario programmato per cadere in [refStart, refEnd]
  let dayShift = Math.floor((refStart - rawDepSched) / DAY_MS);
  while (rawDepSched + dayShift * DAY_MS < refStart) dayShift++;
  const shiftMs = dayShift * DAY_MS;

  const depSched = rawDepSched + shiftMs;
  if (depSched >= refEnd) return null;
  const arrSched = depSched + durMs;

  // Se il treno nel tabellone di oggi è già passato/completato ma cade in una finestra futura (dopo mezzanotte / domani), è una corsa futura
  const isFutureDay = dayShift > 0 || (depSched > nowMs + 1800000 && stopA.actualFermataType === 1);
  if (!isFutureDay && (stopA.actualFermataType === 3 || stopB.actualFermataType === 3)) return null;

  const ritardo = isFutureDay ? 0 : (andamento.ritardo ?? summary?.ritardo ?? 0);

  const depReal = isFutureDay
    ? depSched
    : (stopA.partenzaReale ? stopA.partenzaReale + shiftMs : depSched + Math.max(0, ritardo) * 60000);

  const arrReal = isFutureDay
    ? arrSched
    : (stopB.arrivoReale ? stopB.arrivoReale + shiftMs : arrSched + Math.max(0, ritardo) * 60000);

  const binPartenza =
    (!isFutureDay && stopA.binarioEffettivoPartenzaDescrizione) ||
    stopA.binarioProgrammatoPartenzaDescrizione ||
    (!isFutureDay && summary?.binarioEffettivoPartenzaDescrizione) ||
    summary?.binarioProgrammatoPartenzaDescrizione ||
    stopA.binarioEffettivoPartenzaDescrizione ||
    "-";

  const binArrivo =
    (!isFutureDay && stopB.binarioEffettivoArrivoDescrizione) ||
    stopB.binarioProgrammatoArrivoDescrizione ||
    stopB.binarioEffettivoArrivoDescrizione ||
    "-";

  const stopsSlice = andamento.fermate.slice(idxA, idxB + 1).map((f) => {
    const rawProg = f.partenza_teorica || f.arrivo_teorico || f.programmata || rawDepSched;
    let stopDur = rawProg - rawDepSched;
    if (stopDur < -3600000) stopDur += DAY_MS;
    const prog = depSched + stopDur;
    const eff = !isFutureDay && (f.partenzaReale || f.arrivoReale)
      ? (f.partenzaReale || f.arrivoReale) + shiftMs
      : null;
    return {
      id: f.id,
      stazione: f.stazione,
      programmata: prog,
      effettiva: eff,
      ritardo: isFutureDay ? 0 : (f.ritardoPartenza ?? f.ritardoArrivo ?? 0),
      effettuata: isFutureDay ? false : f.actualFermataType === 1
    };
  });

  return {
    numeroTreno: andamento.numeroTreno || summary.numeroTreno,
    codOrigine: summary?.codOrigine || andamento.codOrigine || null,
    dataPartenzaTreno: summary?.dataPartenzaTreno || null,
    isFutureDay,
    dayShift,
    categoria: andamento.compTipologiaTreno || summary?.categoriaDescrizione || summary?.categoria || "REG",
    origine: andamento.origine,
    destinazione: andamento.destinazione,
    fromId: stationA,
    fromName: STATION_NAMES[stationA] || pretty(stopA.stazione),
    toId: stationB,
    toName: STATION_NAMES[stationB] || pretty(stopB.stazione),
    orarioPartenza: depSched,
    orarioPartenzaStimato: depReal,
    orarioArrivo: arrSched,
    orarioArrivoStimato: arrReal,
    ritardo,
    binarioPartenza: binPartenza,
    binarioArrivo: binArrivo,
    ultimoRilevamentoStazione: isFutureDay ? "--" : (andamento.stazioneUltimoRilevamento || "--"),
    ultimoRilevamentoOra: isFutureDay ? null : (andamento.oraUltimoRilevamento || null),
    arrivatoADestinazione: isFutureDay ? false : stopB.actualFermataType === 1,
    loadedLive: true,
    fermate: stopsSlice
  };
}

const WINDOW_H = 5;
const MAX_FROM_TRAINS = 45;
const MAX_TO_TRAINS = 60;

async function mainHandler(q) {
  const { from, to } = q || {};
  if (!from || !to || from === to) {
    return { statusCode: 400, body: JSON.stringify({ error: "Parametri non validi" }) };
  }

  try {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const todayMid = romeMidnight(now);
    const MIN_WAIT = 4;
    const MAX_WAIT = 75;
    const H = 3600000;

    const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 6);
    let t0 = Number(q.t0);
    if (!isFinite(t0) || Math.abs(t0 - nowMs) > 24 * H) t0 = nowMs;
    const winStart = t0 + offset * WINDOW_H * H;
    const winEnd = winStart + WINDOW_H * H;
    const lowBound = offset === 0 ? nowMs - 60000 : winStart;
    const slotStart = offset === 0 ? nowMs : winStart;

    // Riporta qualsiasi timestamp futuro alla giornata odierna [todayMid, todayMid + 24h) per interrogare il tabellone di ViaggiaTreno
    function toTodayQueryStr(targetMs) {
      let qMs = targetMs;
      while (qMs >= todayMid + DAY_MS) qMs -= DAY_MS;
      while (qMs < todayMid) qMs += DAY_MS;
      return vtDate(new Date(qMs));
    }

    const andamentoCache = new Map();

    // Carica andamentoTreno usando direttamente todayMid (evitando che cercaNumeroTrenoTrenoAutocomplete restituisca domani mattina con andamento null)
    function loadTrain(t) {
      const num = t.numeroTreno;
      const codInit = t.codOrigine || "";
      const cacheKey = `${codInit}-${num}`;
      if (andamentoCache.has(cacheKey)) return andamentoCache.get(cacheKey);

      const p = (async () => {
        let cod = t.codOrigine;
        let dep = todayMid;

        if (!cod) {
          const txt = await fetchText(`${VT_BASE}/cercaNumeroTrenoTrenoAutocomplete/${num}`);
          const line = (txt || "").trim().split("\n")[0] || "";
          const parts = (line.split("|")[1] || "").trim().split("-");
          if (parts.length >= 3) {
            cod = parts[1];
            dep = parts[2] || todayMid;
          }
        }
        if (!cod) return { summary: t, andamento: null };

        // 1. Prova prima con la mezzanotte di oggi (dove ViaggiaTreno conserva tutte le corse della giornata)
        let and = await fetchJson(`${VT_BASE}/andamentoTreno/${cod}/${num}/${todayMid}`);

        // 2. Se non trovato (es. treno notturno partito prima di mezzanotte o già ruotato a domani), prova ieri o domani
        if (!and || !Array.isArray(and.fermate)) {
          and = await fetchJson(`${VT_BASE}/andamentoTreno/${cod}/${num}/${todayMid - DAY_MS}`);
          if (and && Array.isArray(and.fermate)) dep = todayMid - DAY_MS;
        }
        if (!and || !Array.isArray(and.fermate)) {
          and = await fetchJson(`${VT_BASE}/andamentoTreno/${cod}/${num}/${todayMid + DAY_MS}`);
          if (and && Array.isArray(and.fermate)) dep = todayMid + DAY_MS;
        }

        return { summary: { ...t, codOrigine: cod, dataPartenzaTreno: dep }, andamento: and };
      })();

      andamentoCache.set(cacheKey, p);
      return p;
    }

    async function getBoardList(stationId, slotStrings, kind, refStart, refEnd) {
      const uniqueSlots = Array.from(new Set(slotStrings));
      const lists = await Promise.all(
        uniqueSlots.map((s) => fetchJson(`${VT_BASE}/${kind}/${stationId}/${encodeURIComponent(s)}`))
      );
      const unique = new Map();
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (EXCLUDED_CATS.has(t.categoria)) continue;
          const key = `${t.codOrigine || ""}-${t.numeroTreno}`;
          if (!unique.has(key)) {
            let rawTime = (kind === "arrivi" ? t.orarioArrivo || t.orarioPartenza : t.orarioPartenza) || 0;
            if (rawTime > 0) {
              while (rawTime < refStart - 60 * 60000) rawTime += DAY_MS;
              while (rawTime >= refEnd + 240 * 60000) rawTime -= DAY_MS;
            }
            unique.set(key, { ...t, _sortTime: rawTime });
          }
        }
      }
      return Array.from(unique.values())
        .filter((t) => !t._sortTime || (t._sortTime >= refStart - 60 * 60000 && t._sortTime < refEnd))
        .sort((a, b) => a._sortTime - b._sortTime);
    }

    const depSlots = [];
    for (let t = slotStart; t <= winEnd; t += 45 * 60000) depSlots.push(toTodayQueryStr(t));
    const arrSlots = [];
    for (let t = slotStart + 30 * 60000; t <= winEnd + 210 * 60000; t += 45 * 60000) arrSlots.push(toTodayQueryStr(t));

    const [fromList, toList] = await Promise.all([
      getBoardList(from, depSlots, "partenze", lowBound, winEnd),
      getBoardList(to, arrSlots, "arrivi", lowBound, winEnd + 210 * 60000)
    ]);

    const toNums = new Set(toList.map((t) => String(t.numeroTreno)));
    let directCand = fromList.filter((t) => toNums.has(String(t.numeroTreno)));
    if (directCand.length === 0) directCand = fromList;
    directCand = directCand.slice(0, MAX_FROM_TRAINS);

    const directRaw = await Promise.all(directCand.map(loadTrain));
    const directTrains = directRaw
      .map(({ summary, andamento }) => extractLeg(andamento, summary, from, to, lowBound, winEnd, nowMs))
      .filter(Boolean)
      .sort((a, b) => a.orarioPartenza - b.orarioPartenza);

    const windowInfo = { start: winStart, end: winEnd, offset };

    if (directTrains.length > 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "direct", updatedAt: nowMs, window: windowInfo, trains: directTrains })
      };
    }

    const [fromRaw, toRaw] = await Promise.all([
      Promise.all(fromList.slice(0, MAX_FROM_TRAINS).map(loadTrain)),
      Promise.all(toList.slice(0, MAX_TO_TRAINS).map(loadTrain))
    ]);

    const fromOk = fromRaw.filter((x) => x.andamento && Array.isArray(x.andamento.fermate));
    const toOk = toRaw.filter((x) => x.andamento && Array.isArray(x.andamento.fermate));

    const found = [];
    for (const A of fromOk) {
      const fa = A.andamento.fermate;
      const iFrom = fa.findIndex((f) => matchStation(f.id, from));
      if (iFrom === -1) continue;

      for (const B of toOk) {
        const fb = B.andamento.fermate;
        const iTo = fb.findIndex((f) => matchStation(f.id, to));
        if (iTo === -1) continue;
        if (String(A.summary.numeroTreno) === String(B.summary.numeroTreno)) continue;

        for (let i = iFrom + 1; i < fa.length; i++) {
          const hubId = fa[i].id;
          if (matchStation(hubId, to)) continue;
          const j = fb.findIndex((f, idx) => matchStation(f.id, hubId) && idx < iTo);
          if (j === -1) continue;

          const l1 = extractLeg(A.andamento, A.summary, from, hubId, lowBound, winEnd, nowMs);
          if (!l1) continue;

          // Allinea la seconda tratta direttamente alla finestra di interscambio [l1.orarioArrivo, l1.orarioArrivo + MAX_WAIT]
          const l2 = extractLeg(
            B.andamento,
            B.summary,
            hubId,
            to,
            l1.orarioArrivo + MIN_WAIT * 60000,
            l1.orarioArrivo + (MAX_WAIT + 1) * 60000,
            nowMs
          );
          if (!l2) continue;

          const waitScheduledMin = Math.round((l2.orarioPartenza - l1.orarioArrivo) / 60000);
          const waitRealMin = Math.round((l2.orarioPartenzaStimato - l1.orarioArrivoStimato) / 60000);
          if (waitScheduledMin < MIN_WAIT || waitScheduledMin > MAX_WAIT) continue;
          if (waitRealMin < 3) continue;

          found.push({
            id: `${l1.numeroTreno}-${l2.numeroTreno}-${hubId}-${l1.orarioPartenza}`,
            sameStation: true,
            hubArrivalName: l1.toName,
            hubDepartureName: l2.fromName,
            waitScheduledMin,
            waitRealMin,
            status: waitRealMin < 8 ? "tight" : "safe",
            totaleDurataMin: Math.round((l2.orarioArrivoStimato - l1.orarioPartenzaStimato) / 60000),
            leg1: l1,
            leg2: l2,
            backupLeg2: null
          });
        }
      }
    }

    const bestPerTrain1 = new Map();
    for (const c of found) {
      const k = `${c.leg1.numeroTreno}-${c.leg1.orarioPartenza}`;
      const e = bestPerTrain1.get(k);
      if (!e || c.leg2.orarioArrivoStimato < e.leg2.orarioArrivoStimato) bestPerTrain1.set(k, c);
    }

    const byDepDesc = Array.from(bestPerTrain1.values()).sort(
      (a, b) => b.leg1.orarioPartenza - a.leg1.orarioPartenza
    );
    let minArr = Infinity;
    const pareto = [];
    for (const c of byDepDesc) {
      if (c.leg2.orarioArrivoStimato < minArr) {
        pareto.push(c);
        minArr = c.leg2.orarioArrivoStimato;
      }
    }
    const finalConnections = pareto
      .sort((a, b) => a.leg1.orarioPartenza - b.leg1.orarioPartenza)
      .slice(0, 14);

    for (const c of finalConnections) {
      const hubId = c.leg2.fromId;
      let backup = null;
      for (const B of toOk) {
        const lb = extractLeg(
          B.andamento,
          B.summary,
          hubId,
          to,
          c.leg2.orarioPartenza + 60000,
          c.leg2.orarioPartenza + 180 * 60000,
          nowMs
        );
        if (lb && lb.orarioPartenza > c.leg2.orarioPartenza) {
          if (!backup || lb.orarioPartenza < backup.orarioPartenza) backup = lb;
        }
      }
      if (backup) {
        c.backupLeg2 = {
          numeroTreno: backup.numeroTreno,
          categoria: backup.categoria,
          orarioPartenza: backup.orarioPartenza,
          binarioPartenza: backup.binarioPartenza
        };
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "connections",
        updatedAt: nowMs,
        window: windowInfo,
        connections: finalConnections,
        stats: { treniDaPartenza: fromOk.length, treniVersoDestinazione: toOk.length }
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Errore calcolo coincidenze", details: err.message })
    };
  }
}

const handler = async (event) => mainHandler(event.queryStringParameters || {});

module.exports = async (req, res) => {
  if (req && req.query && res && typeof res.status === "function") {
    const out = await mainHandler(req.query);
    res.status(out.statusCode).setHeader("Content-Type", "application/json").send(out.body);
    return;
  }
  return handler(req);
};
module.exports.handler = handler;
