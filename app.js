const OFFICIAL_GTFS_URL = "https://api3.ottop.org/download/gtfs/ooXuXei4op7y/5000020472115";
const CITY_SOURCE_URL = "https://www.city.okinawa.okinawa.jp/k036-001/chiikikankyou/koukyoukoutsuu/shibus/25042.html";
const REQUIRED_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"];
const FREE_TRANSFER_STOPS = new Set(["中部興産沖縄市役所前", "BCコザ（市立図書館）", "ミュージックタウン"]);
const WALK_TRANSFER_PAIRS = [["美里市営住宅前", "美原4丁目"]];

const state = {
  feed: null,
  graph: null,
  stopsByName: new Map(),
  lastSource: ""
};

const el = {
  status: document.getElementById("dataStatus"),
  from: document.getElementById("fromStop"),
  to: document.getElementById("toStop"),
  date: document.getElementById("serviceDate"),
  time: document.getElementById("departTime"),
  search: document.getElementById("searchBtn"),
  swap: document.getElementById("swapBtn"),
  file: document.getElementById("gtfsFile"),
  retry: document.getElementById("retryBtn"),
  list: document.getElementById("stopList"),
  results: document.getElementById("results")
};

init();

function init() {
  const now = new Date();
  el.date.value = toDateInput(now);
  el.time.value = toTimeInput(now);
  el.search.addEventListener("click", searchRoute);
  el.swap.addEventListener("click", () => {
    [el.from.value, el.to.value] = [el.to.value, el.from.value];
  });
  el.retry.addEventListener("click", () => loadOfficialGtfs());
  el.file.addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) loadZipBlob(file, file.name);
  });
  loadOfficialGtfs();
}

async function loadOfficialGtfs() {
  setStatus("公式GTFSを取得中...", false);
  try {
    const res = await fetch(OFFICIAL_GTFS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadZipBlob(await res.blob(), "公式GTFS");
  } catch (error) {
    setStatus("公式GTFSの自動取得に失敗。ZIPを読み込んでください。", true);
    showMessage(`公式GTFSをブラウザから取得できませんでした。データ更新・読み込み欄からGTFS ZIPを選択してください。詳細: ${error.message}`);
  }
}

async function loadZipBlob(blob, sourceLabel) {
  setStatus(`${sourceLabel}を解析中...`, false);
  try {
    const files = await unzipGtfs(await blob.arrayBuffer());
    const missing = REQUIRED_FILES.filter(name => !files[name]);
    if (missing.length) throw new Error(`必要なGTFSファイルが不足しています: ${missing.join(", ")}`);
    state.feed = parseGtfs(files);
    state.graph = buildGraph(state.feed);
    state.lastSource = sourceLabel;
    fillStops(state.feed.stops);
    setStatus(`${sourceLabel}: ${state.feed.stops.length}停留所 / ${state.feed.trips.length}便`, false);
    showMessage("データを読み込みました。出発地・目的地・時刻を指定して検索してください。");
  } catch (error) {
    setStatus("GTFS解析に失敗しました", true);
    showMessage(`読み込みに失敗しました: ${error.message}`);
  }
}

function parseGtfs(files) {
  const stops = parseCsv(files["stops.txt"])
    .filter(row => !row.location_type || row.location_type === "0")
    .map(row => ({ id: row.stop_id, name: cleanName(row.stop_name), lat: Number(row.stop_lat), lon: Number(row.stop_lon) }));
  const routes = new Map(parseCsv(files["routes.txt"]).map(row => [row.route_id, {
    id: row.route_id,
    name: cleanName(row.route_short_name || row.route_long_name),
    longName: cleanName(row.route_long_name || row.route_short_name)
  }]));
  const trips = parseCsv(files["trips.txt"]).map(row => ({
    id: row.trip_id,
    routeId: row.route_id,
    serviceId: row.service_id,
    headsign: cleanName(row.trip_headsign || "")
  }));
  const stopTimesByTrip = new Map();
  for (const row of parseCsv(files["stop_times.txt"])) {
    const item = {
      tripId: row.trip_id,
      arrival: timeToMinutes(row.arrival_time),
      departure: timeToMinutes(row.departure_time),
      stopId: row.stop_id,
      sequence: Number(row.stop_sequence)
    };
    if (!stopTimesByTrip.has(item.tripId)) stopTimesByTrip.set(item.tripId, []);
    stopTimesByTrip.get(item.tripId).push(item);
  }
  for (const times of stopTimesByTrip.values()) times.sort((a, b) => a.sequence - b.sequence);
  const calendars = parseCalendars(files["calendar.txt"], files["calendar_dates.txt"]);
  return { stops, stopById: new Map(stops.map(stop => [stop.id, stop])), routes, trips, tripById: new Map(trips.map(trip => [trip.id, trip])), stopTimesByTrip, calendars };
}

function parseCalendars(calendarText, dateText) {
  const services = new Map();
  for (const row of parseCsv(calendarText)) {
    services.set(row.service_id, {
      id: row.service_id,
      start: row.start_date,
      end: row.end_date,
      days: [row.sunday, row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday].map(v => v === "1"),
      exceptions: new Map()
    });
  }
  for (const row of parseCsv(dateText)) {
    if (!services.has(row.service_id)) {
      services.set(row.service_id, { id: row.service_id, start: "00000000", end: "99999999", days: [false, false, false, false, false, false, false], exceptions: new Map() });
    }
    services.get(row.service_id).exceptions.set(row.date, row.exception_type);
  }
  return services;
}

function buildGraph(feed) {
  const departures = new Map();
  const walkTransfers = new Map();
  const addWalk = (from, to) => {
    if (!walkTransfers.has(from)) walkTransfers.set(from, []);
    walkTransfers.get(from).push({ to, minutes: 4 });
  };
  for (const [aName, bName] of WALK_TRANSFER_PAIRS) {
    for (const a of feed.stops.filter(stop => stop.name === aName)) {
      for (const b of feed.stops.filter(stop => stop.name === bName)) {
        addWalk(a.id, b.id);
        addWalk(b.id, a.id);
      }
    }
  }
  for (const trip of feed.trips) {
    const times = feed.stopTimesByTrip.get(trip.id) || [];
    const route = feed.routes.get(trip.routeId) || { name: trip.routeId, longName: trip.routeId };
    for (let i = 0; i < times.length - 1; i++) {
      const from = times[i];
      if (!departures.has(from.stopId)) departures.set(from.stopId, []);
      departures.get(from.stopId).push({
        tripId: trip.id,
        routeId: trip.routeId,
        routeName: route.name || route.longName,
        headsign: trip.headsign,
        serviceId: trip.serviceId,
        depart: from.departure,
        stopIndex: i,
        times
      });
    }
  }
  for (const list of departures.values()) list.sort((a, b) => a.depart - b.depart);
  return { departures, walkTransfers };
}

function fillStops(stops) {
  const unique = new Map();
  for (const stop of stops) if (!unique.has(stop.name)) unique.set(stop.name, stop);
  state.stopsByName = unique;
  el.list.innerHTML = [...unique.keys()].sort((a, b) => a.localeCompare(b, "ja")).map(name => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function searchRoute() {
  if (!state.feed || !state.graph) {
    showMessage("先にGTFSデータを読み込んでください。");
    return;
  }
  const fromStop = resolveStop(cleanName(el.from.value));
  const toStop = resolveStop(cleanName(el.to.value));
  if (!fromStop || !toStop) {
    showMessage("出発停留所と到着停留所を候補から選んでください。");
    return;
  }
  if (fromStop.id === toStop.id) {
    showMessage("出発停留所と到着停留所が同じです。");
    return;
  }
  const startMinute = timeToMinutes(`${el.time.value}:00`);
  const serviceKey = el.date.value.replaceAll("-", "");
  const route = findEarliestRoute(fromStop.id, toStop.id, startMinute, serviceKey);
  if (!route) {
    showMessage("指定時刻以降に到着できる候補が見つかりませんでした。運休日、最終便後、またはデータ未読み込みの可能性があります。");
    return;
  }
  renderRoute(route, fromStop, toStop, startMinute);
}

function findEarliestRoute(originId, targetId, startMinute, serviceKey) {
  const best = new Map([[originId, startMinute]]);
  const previous = new Map();
  const queue = [{ stopId: originId, time: startMinute, transfers: 0, lastTripId: "" }];
  const serviceTripCache = new Map();
  const tripRuns = dep => {
    if (!serviceTripCache.has(dep.serviceId)) serviceTripCache.set(dep.serviceId, isServiceActive(dep.serviceId, serviceKey));
    return serviceTripCache.get(dep.serviceId);
  };

  while (queue.length) {
    queue.sort((a, b) => a.time - b.time);
    const current = queue.shift();
    if (current.time !== best.get(current.stopId)) continue;
    if (current.stopId === targetId) break;

    for (const walk of state.graph.walkTransfers.get(current.stopId) || []) {
      const arrive = current.time + walk.minutes;
      relax(walk.to, arrive, {
        type: "walk",
        fromStopId: current.stopId,
        toStopId: walk.to,
        depart: current.time,
        arrive,
        minutes: walk.minutes
      });
    }

    const departures = state.graph.departures.get(current.stopId) || [];
    for (const dep of departures) {
      if (dep.depart < current.time || !tripRuns(dep)) continue;
      for (let j = dep.stopIndex + 1; j < dep.times.length; j++) {
        const arrival = dep.times[j];
        if (arrival.arrival < dep.depart) continue;
        const stopId = arrival.stopId;
        relax(stopId, arrival.arrival, {
          type: "ride",
          fromStopId: current.stopId,
          toStopId: stopId,
          depart: dep.depart,
          arrive: arrival.arrival,
          tripId: dep.tripId,
          routeId: dep.routeId,
          routeName: dep.routeName,
          headsign: dep.headsign
        });
      }
    }
  }

  if (!best.has(targetId)) return null;
  const legs = [];
  let cursor = targetId;
  while (cursor !== originId) {
    const leg = previous.get(cursor);
    if (!leg) return null;
    legs.push(leg);
    cursor = leg.fromStopId;
  }
  return { arrive: best.get(targetId), legs: compactLegs(legs.reverse()) };

  function relax(stopId, arrive, leg) {
    if (arrive >= (best.get(stopId) ?? Infinity)) return;
    best.set(stopId, arrive);
    previous.set(stopId, leg);
    queue.push({ stopId, time: arrive });
  }
}

function compactLegs(legs) {
  const compact = [];
  for (const leg of legs) {
    const last = compact[compact.length - 1];
    if (last && leg.type === "ride" && last.type === "ride" && last.tripId === leg.tripId && last.toStopId === leg.fromStopId) {
      last.toStopId = leg.toStopId;
      last.arrive = leg.arrive;
    } else {
      compact.push({ ...leg });
    }
  }
  return compact;
}

function isServiceActive(serviceId, serviceKey) {
  const service = state.feed.calendars.get(serviceId);
  if (!service) return true;
  const exception = service.exceptions.get(serviceKey);
  if (exception === "1") return true;
  if (exception === "2") return false;
  if (serviceKey < service.start || serviceKey > service.end) return false;
  const date = new Date(`${serviceKey.slice(0, 4)}-${serviceKey.slice(4, 6)}-${serviceKey.slice(6, 8)}T00:00:00`);
  return Boolean(service.days[date.getDay()]);
}

function renderRoute(route, fromStop, toStop, startMinute) {
  const total = route.arrive - startMinute;
  const rides = route.legs.filter(leg => leg.type === "ride");
  const transferCount = Math.max(0, rides.length - 1);
  const wait = route.legs.reduce((sum, leg, index) => {
    const prevTime = index === 0 ? startMinute : route.legs[index - 1].arrive;
    return sum + Math.max(0, leg.depart - prevTime);
  }, 0);
  const source = state.lastSource ? ` / ${state.lastSource}` : "";
  el.results.innerHTML = `
    <article class="route-card">
      <div class="summary">
        <div class="metric"><span>到着</span><strong>${formatTime(route.arrive)}</strong></div>
        <div class="metric"><span>総移動時間</span><strong>${total}分</strong></div>
        <div class="metric"><span>乗継回数</span><strong>${transferCount}回</strong></div>
        <div class="metric"><span>待ち時間合計</span><strong>${wait}分</strong></div>
      </div>
      ${route.legs.map((leg, index) => renderLeg(leg, index, route.legs)).join("")}
      <p class="leg-detail">データ出典: <a href="${CITY_SOURCE_URL}" target="_blank" rel="noreferrer">沖縄市公式ページ</a>${escapeHtml(source)}。道路状況による遅延は反映していません。</p>
    </article>
  `;
}

function renderLeg(leg, index, legs) {
  const from = state.feed.stopById.get(leg.fromStopId)?.name || leg.fromStopId;
  const to = state.feed.stopById.get(leg.toStopId)?.name || leg.toStopId;
  const prev = legs[index - 1];
  const wait = prev ? Math.max(0, leg.depart - prev.arrive) : 0;
  if (leg.type === "walk") {
    return `
      <div class="leg">
        <div class="leg-time">${formatTime(leg.depart)}</div>
        <div class="leg-body">
          <span class="route-name">徒歩連絡</span>
          <p class="leg-title">${escapeHtml(from)} → ${escapeHtml(to)}</p>
          <p class="leg-detail">乗継指定停留所間の徒歩連絡として${leg.minutes}分で計算しています。</p>
        </div>
      </div>`;
  }
  const transferText = prev ? `<span class="transfer">待ち${wait}分</span> / ` : "";
  const free = isFreeTransferStop(from) ? "無料乗継券の対象停留所です。" : "同一停留所での乗継として計算しています。";
  return `
    <div class="leg">
      <div class="leg-time">${formatTime(leg.depart)}<br>${formatTime(leg.arrive)}</div>
      <div class="leg-body">
        <span class="route-name ${routeClass(leg.routeName)}">${escapeHtml(leg.routeName)}</span>
        <p class="leg-title">${escapeHtml(from)} → ${escapeHtml(to)}</p>
        <p class="leg-detail">${transferText}${leg.arrive - leg.depart}分乗車。${escapeHtml(formatHeadsign(leg.headsign))}。${index > 0 ? free : ""}</p>
      </div>
    </div>`;
}

function resolveStop(name) {
  if (state.stopsByName.has(name)) return state.stopsByName.get(name);
  if (state.stopsByName.has(`${name}バス停`)) return state.stopsByName.get(`${name}バス停`);
  const normalized = name.replace(/\s+/g, "");
  const candidates = [...state.stopsByName.entries()].filter(([stopName]) => stopName.replace(/\s+/g, "") === normalized);
  return candidates.length === 1 ? candidates[0][1] : null;
}

function formatHeadsign(headsign) {
  const value = cleanName(headsign || "循環便");
  return value.endsWith("方面") || value.endsWith("行") ? value : `${value}方面`;
}

function isFreeTransferStop(name) {
  return FREE_TRANSFER_STOPS.has(name) || WALK_TRANSFER_PAIRS.some(pair => pair.includes(name));
}

function routeClass(name) {
  if (name.includes("西部")) return "west";
  if (name.includes("東部")) return "east";
  if (name.includes("北部")) return "north";
  if (name.includes("中部")) return "middle";
  return "";
}

async function unzipGtfs(buffer) {
  const data = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const files = {};
  let ptr = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("ZIP中央ディレクトリを読めません。");
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const fileNameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decodeUtf8(data.slice(ptr + 46, ptr + 46 + fileNameLength));
    if (name.endsWith(".txt")) files[name.split("/").pop()] = await readZipEntry(data, localOffset, compressedSize, method);
    ptr += 46 + fileNameLength + extraLength + commentLength;
  }
  return files;
}

async function readZipEntry(data, localOffset, compressedSize, method) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIPローカルヘッダを読めません。");
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = data.slice(start, start + compressedSize);
  if (method === 0) return decodeUtf8(compressed);
  if (method !== 8) throw new Error(`未対応のZIP圧縮方式です: ${method}`);
  if (!("DecompressionStream" in window)) throw new Error("このブラウザはZIP展開に必要なDecompressionStreamに対応していません。");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function findEndOfCentralDirectory(data) {
  for (let i = data.length - 22; i >= Math.max(0, data.length - 66000); i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) return i;
  }
  throw new Error("ZIPの終端情報が見つかりません。");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") {
        value += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += ch;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift()?.map(header => header.trim()) || [];
  return rows.filter(cols => cols.length > 1 || cols[0]).map(cols => Object.fromEntries(headers.map((key, index) => [key, cols[index] ?? ""])));
}

function timeToMinutes(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toDateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toTimeInput(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function setStatus(text, isError) {
  el.status.textContent = text;
  el.status.style.borderColor = isError ? "#e58a8a" : "";
  el.status.style.color = isError ? "#9b2c2c" : "";
}

function showMessage(message) {
  el.results.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}
