const VT_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
const DAY_MS = 24 * 3600000;
const H_MS = 3600000;

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
  return String(name || "")
    .toLowerCase()
    .replace(/(^|[\s'.\-/])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
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
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14)" },
      signal: AbortSignal.timeout(6500)
    });
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
      signal: AbortSignal.timeout(6500)
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function extractLeg(andamento, summary, stationA, stationB, refStart, refEnd, nowMs) {
  if (!andamento || !Array.isArray(andamento.fermate)) return null;

  const idxA = andamento.fermate.findIndex((f) => matchStation(f.id, stationA));
  const idxB = andamento.fermate.findIndex((f) => matchStation(f.id, stationB));
  if (idxA === -1 || idxB === -1 || idxA >= idxB) return null;

  const stopA = andamento.fermate[idxA];
  const stopB = andamento.fermate[idxB];

  const rawDepSched = stopA.partenza_teorica || stopA.programmata || summary?._rawBoardTime;
  const rawArrSched = stopB.arrivo_teorico || stopB.programmata || stopB.partenza_teorica;
  if (!rawDepSched || !rawArrSched) return null;

  let durMs = rawArrSched - rawDepSched;
  if (durMs < 0) durMs += DAY_MS;

  let dayShift = Math.floor((refStart - rawDepSched) / DAY_MS);
  while (rawDepSched + dayShift * DAY_MS < refStart) dayShift++;
  const shiftMs = dayShift * DAY_MS;

  const depSched = rawDepSched + shiftMs;
  if (depSched >= refEnd) return null;
  const arrSched = depSched + durMs;

  const isFutureDay = dayShift !== 0 || depSched > nowMs + 1800000;
  if (!isFutureDay && (stopA.actualFermataType === 3 || stopB.actualFermataType === 3)) return null;

  const isLiveRun = !isFutureDay && Math.abs(depSched - nowMs) < 6 * H_MS;
  const ritardo = isLiveRun ? (andamento.ritardo ?? summary?.ritardo ?? 0) : 0;

  const depReal = isLiveRun
    ? (stopA.partenzaReale ? stopA.partenzaReale + shiftMs : depSched + Math.max(0, ritardo) * 60000)
    : depSched;

  const arrReal = isLiveRun
    ? (stopB.arrivoReale ? stopB.arrivoReale + shiftMs : arrSched + Math.max(0, ritardo) * 60000)
    : arrSched;

  const binPartenza =
    (isLiveRun && stopA.binarioEffettivoPartenzaDescrizione) ||
    stopA.binarioProgrammatoPartenzaDescrizione ||
    (isLiveRun && summary?.binarioEffettivoPartenzaDescrizione) ||
    summary?.binarioProgrammatoPartenzaDescrizione ||
    stopA.binarioEffettivoPartenzaDescrizione ||
    "-";

  const binArrivo =
    (isLiveRun && stopB.binarioEffettivoArrivoDescrizione) ||
    stopB.binarioProgrammatoArrivoDescrizione ||
    stopB.binarioEffettivoArrivoDescrizione ||
    "-";

  const stopsSlice = andamento.fermate.slice(idxA, idxB + 1).map((f) => {
    const rawProg = f.partenza_teorica || f.arrivo_teorico || f.programmata || rawDepSched;
    let stopDur = rawProg - rawDepSched;
    if (stopDur < -3600000) stopDur += DAY_MS;
    const prog = depSched + stopDur;
    const eff = isLiveRun && (f.partenzaReale || f.arrivoReale)
      ? (f.partenzaReale || f.arrivoReale) + shiftMs
      : null;
    return {
      id: f.id,
      stazione: STATION_NAMES[f.id] || pretty(f.stazione),
      programmata: prog,
      effettiva: eff,
      ritardo: isLiveRun ? (f.ritardoPartenza ?? f.ritardoArrivo ?? 0) : 0,
      effettuata: isLiveRun ? f.actualFermataType === 1 : (depSched < nowMs)
    };
  });

  return {
    numeroTreno: andamento.numeroTreno || summary.numeroTreno,
    codOrigine: summary?.codOrigine || andamento.codOrigine || null,
    dataPartenzaTreno: summary?.dataPartenzaTreno || null,
    isFutureDay,
    dayShift,
    categoria: andamento.compTipologiaTreno || summary?.categoriaDescrizione || summary?.categoria || "REG",
    origine: pretty(andamento.origine || summary?.origine),
    destinazione: pretty(andamento.destinazione || summary?.destinazione),
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
    ultimoRilevamentoStazione: isLiveRun ? (pretty(andamento.stazioneUltimoRilevamento) || "--") : "--",
    ultimoRilevamentoOra: isLiveRun ? (andamento.oraUltimoRilevamento || null) : null,
    arrivatoADestinazione: isLiveRun ? stopB.actualFermataType === 1 : false,
    loadedLive: true,
    fermate: stopsSlice
  };
}

const WINDOW_H = 6;
const MAX_FROM_TRAINS = 90;
const MAX_TO_TRAINS = 95;

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

    const defaultSlot = Math.min(3, Math.max(0, Math.floor((nowMs - todayMid) / (WINDOW_H * H_MS))));
    const rawSlot = q.slot !== undefined ? parseInt(q.slot, 10) : (q.offset !== undefined ? parseInt(q.offset, 10) : defaultSlot);
    const slot = Math.min(Math.max(isNaN(rawSlot) ? defaultSlot : rawSlot, 0), 7);

    const winStart = todayMid + slot * WINDOW_H * H_MS;
    const winEnd = winStart + WINDOW_H * H_MS;
    const lowBound = winStart;

    function toBoardQueryStrings(targetMs) {
      let baseToday = targetMs;
      while (baseToday >= todayMid + DAY_MS) baseToday -= DAY_MS;
      while (baseToday < todayMid) baseToday += DAY_MS;

      const nextDay = baseToday + DAY_MS;

      if (baseToday < nowMs - 20 * 60000) {
        return [vtDate(new Date(nextDay)), vtDate(new Date(baseToday))];
      }
      return [vtDate(new Date(baseToday)), vtDate(new Date(nextDay))];
    }

    const andamentoCache = new Map();

    function loadTrain(t) {
      const num = t.numeroTreno;
      const codInit = t.codOrigine || "";
      const cacheKey = `${codInit}-${num}`;
      if (andamentoCache.has(cacheKey)) return andamentoCache.get(cacheKey);

      const p = (async () => {
        let cod = t.codOrigine;
        let boardDep = t.dataPartenzaTreno ? Number(t.dataPartenzaTreno) : null;
        let autoDep = null;

        if (!cod || !boardDep) {
          const txt = await fetchText(`${VT_BASE}/cercaNumeroTrenoTrenoAutocomplete/${num}`);
          const lines = (txt || "").trim().split("\n").filter(Boolean);
          for (const line of lines) {
            const parts = (line.split("|")[1] || "").trim().split("-");
            if (parts.length >= 2) {
              if (!cod) cod = parts[1];
              if (parts[2] && !autoDep) autoDep = Number(parts[2]);
              break;
            }
          }
        }
        if (!cod) return { summary: t, andamento: null };

        const candidates = [];
        const addCand = (ms) => {
          if (ms && isFinite(ms) && !candidates.includes(ms)) candidates.push(ms);
        };
        addCand(todayMid);
        addCand(boardDep);
        addCand(autoDep);
        addCand(todayMid - DAY_MS);
        addCand(todayMid + DAY_MS);

        let and = null;
        let usedDep = todayMid;
        for (const cand of candidates) {
          const res = await fetchJson(`${VT_BASE}/andamentoTreno/${cod}/${num}/${cand}`);
          if (res && Array.isArray(res.fermate) && res.fermate.length > 0) {
            and = res;
            usedDep = cand;
            break;
          }
        }

        return { summary: { ...t, codOrigine: cod, dataPartenzaTreno: usedDep }, andamento: and };
      })();

      andamentoCache.set(cacheKey, p);
      return p;
    }

    async function getBoardList(stationId, slotStrings, kind, refStart, refEnd) {
      const uniqueSlots = Array.from(new Set(slotStrings));
      const stationIds = (stationId === "S01645" || stationId === "S01642")
        ? ["S01645", "S01642"]
        : [stationId];
      const queries = [];
      for (const stId of stationIds) {
        for (const s of uniqueSlots) {
          queries.push(fetchJson(`${VT_BASE}/${kind}/${stId}/${encodeURIComponent(s)}`));
        }
      }
      const lists = await Promise.all(queries);
      const unique = new Map();
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (EXCLUDED_CATS.has(t.categoria)) continue;
          const key = `${t.codOrigine || ""}-${t.numeroTreno}`;
          const rawBoard = (kind === "arrivi" ? t.orarioArrivo || t.orarioPartenza : t.orarioPartenza) || 0;
          if (!unique.has(key)) {
            let alignedTime = rawBoard;
            if (alignedTime > 0) {
              let shift = Math.floor((refStart - 30 * 60000 - alignedTime) / DAY_MS);
              while (alignedTime + shift * DAY_MS < refStart - 30 * 60000) shift++;
              alignedTime = alignedTime + shift * DAY_MS;
            }
            unique.set(key, { ...t, _rawBoardTime: rawBoard, _sortTime: alignedTime });
          }
        }
      }
      return Array.from(unique.values())
        .filter((t) => !t._sortTime || (t._sortTime >= refStart - 30 * 60000 && t._sortTime < refEnd + 30 * 60000))
        .sort((a, b) => a._sortTime - b._sortTime);
    }

    const depSlots = [];
    for (let t = winStart - 30 * 60000; t < winEnd; t += 60 * 60000) {
      for (const s of toBoardQueryStrings(t)) depSlots.push(s);
    }
    const arrSlots = [];
    for (let t = winStart; t <= winEnd + 180 * 60000; t += 60 * 60000) {
      for (const s of toBoardQueryStrings(t)) arrSlots.push(s);
    }

    const [fromList, toList] = await Promise.all([
      getBoardList(from, depSlots, "partenze", lowBound, winEnd),
      getBoardList(to, arrSlots, "arrivi", lowBound, winEnd + 180 * 60000)
    ]);

    const toNums = new Set(toList.map((t) => String(t.numeroTreno)));
    const directMatches = fromList.filter((t) => toNums.has(String(t.numeroTreno)));

    const orderedFrom = [
      ...directMatches,
      ...fromList.filter((t) => !toNums.has(String(t.numeroTreno)))
    ].slice(0, MAX_FROM_TRAINS);

    const fromRaw = await Promise.all(orderedFrom.map(loadTrain));

    const directTrains = fromRaw
      .map(({ summary, andamento }) => extractLeg(andamento, summary, from, to, lowBound, winEnd, nowMs))
      .filter(Boolean)
      .sort((a, b) => a.orarioPartenza - b.orarioPartenza);

    const windowInfo = { start: winStart, end: winEnd, slot };

    if (directTrains.length > 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "direct", updatedAt: nowMs, window: windowInfo, trains: directTrains })
      };
    }

    const toRaw = await Promise.all(toList.slice(0, MAX_TO_TRAINS).map(loadTrain));

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
      .slice(0, 18);

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
