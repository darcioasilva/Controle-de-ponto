import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  Clock, Check, X, Users, ListChecks, Lock, Plus, Trash2, Download, ChevronLeft,
  AlertCircle, Camera, MapPin, FileText, Send, CheckCircle2, XCircle, Image as ImageIcon, Inbox, CalendarDays, FileSpreadsheet, Upload
} from "lucide-react";

// ---------- Storage helpers ----------
const SUPABASE_URL = "https://zdgaccdumndtzyhhazet.supabase.co";
const SUPABASE_KEY = "sb_publishable_Cgrn0cjAM5SammjbkcWx5w_SrBnqO0T";

const EMP_KEY = "ponto-employees";
const PUNCH_KEY = "ponto-punches";
const REQUEST_KEY = "ponto-requests";
const LEAVE_KEY = "ponto-leaves";
const ADMIN_PIN_KEY = "ponto-admin-pin";
const STORE_COORDS_KEY = "ponto-store-coords";
const DEFAULT_ADMIN_PIN = "9999";

const LEAVE_TYPES = [
  { id: "ferias", label: "Férias", color: "#4E9C93" },
  { id: "atestado", label: "Licença médica", color: "#D9685C" },
  { id: "maternidade", label: "Licença maternidade", color: "#C77DB0" },
  { id: "paternidade", label: "Licença paternidade", color: "#6E9CD9" },
  { id: "outro", label: "Outra ausência", color: "#9AA6AF" },
];

async function loadJSON(key, fallback) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ponto_kv?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return fallback;
    const data = await res.json();
    if (!data || data.length === 0) return fallback;
    return data[0].value;
  } catch (e) {
    return fallback;
  }
}
async function saveJSON(key, value) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ponto_kv`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

const STORES = [
  { id: "afrika", label: "Afrika Restaurante" },
  { id: "artex", label: "Artex" },
];

const REQUEST_TYPES = [
  { id: "atestado", label: "Atestado médico" },
  { id: "esqueci", label: "Esqueci de bater o ponto" },
  { id: "correcao", label: "Corrigir horário" },
  { id: "outro", label: "Outro" },
];

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function fmtDate(d) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }
function fmtDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fmtDuration(mins) {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}h${pad2(m)}`;
}

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Seg...Dom, ordem de exibição

// Lê o CSV exportado do Pontomais ("Registros de Ponto") e agrupa as batidas por funcionário
function parsePontomaisCSV(text) {
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data;
  const headerIdx = rows.findIndex(r => r[0] === "Nome" && r[1] === "Data" && r[2] === "Hora");
  if (headerIdx === -1) return { error: "Não encontrei o cabeçalho 'Nome,Data,Hora' — confere se é o relatório certo." };

  const byName = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;
    const [name, dataStr, horaStr] = row;
    if (!name || !dataStr || !horaStr) continue;
    if (name === "Resumo" || name === "Total") continue;
    // dataStr vem como "Sáb, 02/05/2026"
    const m = dataStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const hm = horaStr.match(/^(\d{1,2}):(\d{2})/);
    if (!m || !hm) continue;
    const [, dd, mm, yyyy] = m;
    const [, hh, min] = hm;
    const dt = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0, 0);
    if (isNaN(dt.getTime())) continue;
    byName[name] = byName[name] || [];
    byName[name].push(dt);
  }
  Object.keys(byName).forEach(name => byName[name].sort((a, b) => a - b));
  return { byName };
}


function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Converte o formato antigo (schedule.days + entrada/saida únicos) para o novo
// formato por dia (schedule.perDay = { 0: {entrada,saida}|null, ... 6: ... })
function normalizeSchedule(sch) {
  if (!sch) return null;
  if (sch.perDay) return { perDay: sch.perDay, tolerance: sch.tolerance ?? 10 };
  if (sch.days) {
    const perDay = {};
    sch.days.forEach(d => { perDay[d] = { entrada: sch.entrada, saida: sch.saida }; });
    return { perDay, tolerance: sch.tolerance ?? 10 };
  }
  return null;
}

function formatScheduleSummary(schedule) {
  const norm = normalizeSchedule(schedule);
  if (!norm) return null;
  const segments = [];
  let i = 0;
  while (i < WEEK_ORDER.length) {
    const day = WEEK_ORDER[i];
    const info = norm.perDay[day];
    if (!info) { i++; continue; }
    let j = i;
    while (j + 1 < WEEK_ORDER.length) {
      const nextInfo = norm.perDay[WEEK_ORDER[j + 1]];
      if (nextInfo && nextInfo.entrada === info.entrada && nextInfo.saida === info.saida) j++;
      else break;
    }
    const label = j > i ? `${WEEKDAYS[WEEK_ORDER[i]]}-${WEEKDAYS[WEEK_ORDER[j]]}` : WEEKDAYS[WEEK_ORDER[i]];
    segments.push(`${label} ${info.entrada}-${info.saida}`);
    i = j + 1;
  }
  return segments.length ? segments.join(" · ") : null;
}

// Calcula o fechamento mensal (horas, atrasos, faltas e ausências) por funcionário
function computeMonthlySummary(punches, leaves, employees, storeFilter, monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-${pad2(lastDay)}`;

  const empList = employees.filter(e => storeFilter === "all" || e.store === storeFilter);

  return empList.map(emp => {
    const empPunches = punches
      .filter(p => p.employeeId === emp.id && p.at.slice(0, 7) === monthKey)
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    let totalMin = 0;
    const daysWorked = new Set();
    let lateCount = 0, earlyLeaveCount = 0;
    for (let i = 0; i < empPunches.length; i++) {
      const status = getScheduleStatus(empPunches[i], emp);
      if (status?.label?.startsWith("Atraso")) lateCount++;
      if (status?.label?.startsWith("Saída antecipada")) earlyLeaveCount++;
      if (empPunches[i].action === "entrada" && empPunches[i + 1]?.action === "saida") {
        totalMin += (new Date(empPunches[i + 1].at) - new Date(empPunches[i].at)) / 60000;
        daysWorked.add(fmtDateKey(new Date(empPunches[i].at)));
        i++;
      }
    }

    const leaveDaysByType = {};
    leaves.filter(l => l.employeeId === emp.id).forEach(l => {
      if (l.endDate < monthStart || l.startDate > monthEnd) return;
      const start = l.startDate < monthStart ? monthStart : l.startDate;
      const end = l.endDate > monthEnd ? monthEnd : l.endDate;
      const days = Math.round((new Date(end + "T00:00:00") - new Date(start + "T00:00:00")) / 86400000) + 1;
      leaveDaysByType[l.type] = (leaveDaysByType[l.type] || 0) + days;
    });

    return { emp, totalMin, daysWorked: daysWorked.size, lateCount, earlyLeaveCount, leaveDaysByType };
  });
}

function getScheduleStatus(punch, employee) {
  const norm = normalizeSchedule(employee?.schedule);
  if (!norm) return null;
  const d = new Date(punch.at);
  const day = d.getDay();
  const info = norm.perDay[day];
  if (!info) return { label: "Fora da escala", color: COLORS.amber };
  const punchMin = d.getHours() * 60 + d.getMinutes();
  const tol = norm.tolerance ?? 10;
  if (punch.action === "entrada") {
    const expected = timeToMinutes(info.entrada);
    if (expected == null) return null;
    const diff = punchMin - expected;
    if (diff > tol) return { label: `Atraso de ${diff}min`, color: COLORS.red };
    return { label: "No horário", color: COLORS.teal };
  } else {
    const expected = timeToMinutes(info.saida);
    if (expected == null) return null;
    const diff = expected - punchMin;
    if (diff > tol) return { label: `Saída antecipada (${diff}min)`, color: COLORS.amber };
    return { label: "No horário", color: COLORS.teal };
  }
}

// Verifica se o horário atual exige confirmação antes de bater o ponto
// (chegou cedo demais na entrada, ou está saindo antes da hora)
function checkTimingIssue(employee, action) {
  const norm = normalizeSchedule(employee?.schedule);
  if (!norm) return null;
  const now = new Date();
  const day = now.getDay();
  const info = norm.perDay[day];
  if (!info) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const tol = norm.tolerance ?? 10;
  if (action === "entrada") {
    const expected = timeToMinutes(info.entrada);
    if (expected == null) return null;
    if (nowMin < expected - tol) return { type: "early_entry", expected: info.entrada, diff: expected - nowMin };
    if (nowMin > expected + tol) return { type: "late_entry", expected: info.entrada, diff: nowMin - expected };
  } else {
    const expected = timeToMinutes(info.saida);
    if (expected == null) return null;
    if (nowMin < expected - tol) return { type: "early_exit", expected: info.saida, diff: expected - nowMin };
  }
  return null;
}

// ---------- Geo / image helpers ----------
function getLocation(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

function haversineMeters(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

async function captureSelfie(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 320, height: 240 }, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();
    await new Promise((r) => setTimeout(r, 350));
    const canvas = document.createElement("canvas");
    canvas.width = 240; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, 240, 180);
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch (e) {
    return null;
  }
}

function resizeImageFile(file, maxW = 600, maxH = 800, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const ratio = Math.min(maxW / width, maxH / height, 1);
        width = Math.round(width * ratio); height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- Root ----------
export default function App() {
  const [view, setView] = useState("punch"); // punch | request | admin | admin-login
  const [employees, setEmployees] = useState(null);
  const [punches, setPunches] = useState(null);
  const [requests, setRequests] = useState(null);
  const [leaves, setLeaves] = useState(null);
  const [adminPin, setAdminPin] = useState(DEFAULT_ADMIN_PIN);
  const [storeCoords, setStoreCoords] = useState({});
  const [store, setStore] = useState(STORES[0].id);
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const [emp, pun, req, lea, pin, coords] = await Promise.all([
        loadJSON(EMP_KEY, []),
        loadJSON(PUNCH_KEY, []),
        loadJSON(REQUEST_KEY, []),
        loadJSON(LEAVE_KEY, []),
        loadJSON(ADMIN_PIN_KEY, DEFAULT_ADMIN_PIN),
        loadJSON(STORE_COORDS_KEY, {}),
      ]);
      setEmployees(emp); setPunches(pun); setRequests(req); setLeaves(lea);
      setAdminPin(pin || DEFAULT_ADMIN_PIN); setStoreCoords(coords || {});
      setLoading(false);
    })();
  }, []);

  const persistEmployees = useCallback(async (next) => { setEmployees(next); await saveJSON(EMP_KEY, next); }, []);
  const persistPunches = useCallback(async (next) => { setPunches(next); await saveJSON(PUNCH_KEY, next); }, []);
  const fetchLatestPunches = useCallback(async () => await loadJSON(PUNCH_KEY, []), []);
  const persistRequests = useCallback(async (next) => { setRequests(next); await saveJSON(REQUEST_KEY, next); }, []);
  const persistLeaves = useCallback(async (next) => { setLeaves(next); await saveJSON(LEAVE_KEY, next); }, []);
  const persistAdminPin = useCallback(async (pin) => { setAdminPin(pin); await saveJSON(ADMIN_PIN_KEY, pin); }, []);
  const persistStoreCoords = useCallback(async (next) => { setStoreCoords(next); await saveJSON(STORE_COORDS_KEY, next); }, []);

  if (loading) {
    return <div style={styles.appShell}><div style={{ color: COLORS.textDim, fontFamily: FONT_UI, padding: 24 }}>Carregando…</div></div>;
  }

  return (
    <div style={styles.appShell}>
      <GlobalStyle />
      <TopBar store={store} setStore={setStore} view={view} setView={setView} />
      <div style={styles.body}>
        {view === "punch" && (
          <PunchScreen
            employees={employees} punches={punches} persistPunches={persistPunches}
            store={store} now={now} storeCoords={storeCoords}
            onRequest={() => setView("request")}
          />
        )}
        {view === "request" && (
          <RequestForm
            employees={employees} store={store}
            persistRequests={persistRequests} requests={requests}
            onDone={() => setView("punch")}
          />
        )}
        {view === "admin-login" && (
          <AdminLogin adminPin={adminPin} onSuccess={() => setView("admin")} onCancel={() => setView("punch")} />
        )}
        {view === "admin" && (
          <AdminPanel
            employees={employees} persistEmployees={persistEmployees}
            punches={punches} persistPunches={persistPunches} fetchLatestPunches={fetchLatestPunches}
            requests={requests} persistRequests={persistRequests}
            leaves={leaves} persistLeaves={persistLeaves}
            adminPin={adminPin} persistAdminPin={persistAdminPin}
            storeCoords={storeCoords} persistStoreCoords={persistStoreCoords}
            onExit={() => setView("punch")}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Design tokens ----------
const COLORS = {
  bg: "#12161B", surface: "#1B2129", surfaceRaised: "#232B34", border: "#2E3841",
  amber: "#E8A339", amberDim: "#8A6423", teal: "#4E9C93", red: "#D9685C",
  text: "#F3EFE6", textDim: "#9AA6AF",
};
const FONT_DISPLAY = "'Space Grotesk', 'Helvetica Neue', Arial, sans-serif";
const FONT_UI = "'Inter', 'Helvetica Neue', Arial, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      button { font-family: ${FONT_UI}; cursor: pointer; }
      button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid ${COLORS.amber}; outline-offset: 2px; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 4px; }
      @keyframes popIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
      @keyframes slideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    `}</style>
  );
}

const styles = {
  appShell: {
    minHeight: "100vh",
    background: `radial-gradient(1200px 600px at 50% -10%, #1A2530 0%, ${COLORS.bg} 55%)`,
    color: COLORS.text, fontFamily: FONT_UI, display: "flex", flexDirection: "column",
  },
  body: { flex: 1, display: "flex", flexDirection: "column", padding: "16px", maxWidth: 720, width: "100%", margin: "0 auto" },
};

// ---------- Top bar ----------
function TopBar({ store, setStore, view, setView }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`,
      background: "rgba(18,22,27,0.9)", position: "sticky", top: 0, zIndex: 10, flexWrap: "wrap", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Clock size={20} color={COLORS.amber} />
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 18, letterSpacing: 0.2 }}>Controle de Ponto</span>
      </div>
      {(view === "punch" || view === "request") && (
        <div style={{ display: "flex", gap: 6, background: COLORS.surface, padding: 4, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
          {STORES.map(s => (
            <button key={s.id} onClick={() => setStore(s.id)} style={{
              background: store === s.id ? COLORS.amber : "transparent",
              color: store === s.id ? "#1A1400" : COLORS.textDim,
              border: "none", borderRadius: 7, padding: "7px 12px", fontSize: 13, fontWeight: 600,
            }}>{s.label}</button>
          ))}
        </div>
      )}
      {view !== "punch" ? (
        <button onClick={() => setView("punch")} style={ghostBtnStyle}><ChevronLeft size={16} /> Voltar</button>
      ) : (
        <button onClick={() => setView("admin-login")} style={ghostBtnStyle}><Lock size={14} /> Admin</button>
      )}
    </div>
  );
}

const ghostBtnStyle = {
  display: "flex", alignItems: "center", gap: 6, background: "transparent", color: COLORS.textDim,
  border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 500,
};

// ---------- Punch screen ----------
function PunchScreen({ employees, punches, persistPunches, store, now, storeCoords, onRequest }) {
  const [pin, setPin] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [confirmState, setConfirmState] = useState(null); // { emp, nextAction, type, expected, diff }
  const videoRef = useRef(null);

  const storeEmployees = useMemo(() => employees.filter(e => e.store === store && e.active !== false), [employees, store]);

  const lastActionFor = useCallback((empId) => {
    const list = punches.filter(p => p.employeeId === empId).sort((a, b) => new Date(b.at) - new Date(a.at));
    return list[0] || null;
  }, [punches]);

  const handleDigit = (d) => {
    setError(null);
    if (pin.length >= 4 || capturing) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) setTimeout(() => submitPin(next), 120);
  };
  const handleClear = () => { setPin(""); setError(null); };

  const finalizePunch = async (emp, nextAction, override) => {
    setCapturing(true);
    const [photo, loc] = await Promise.all([
      captureSelfie(videoRef.current),
      getLocation(),
    ]);
    setCapturing(false);

    const coords = storeCoords[store];
    const distance = coords && loc ? haversineMeters(coords, loc) : null;
    const outOfRange = distance != null && coords.radius ? distance > coords.radius : false;

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      employeeId: emp.id, employeeName: emp.name, store, action: nextAction, at: new Date().toISOString(),
      photo: photo || null, location: loc || null, distance, outOfRange,
      earlyOverride: override || null,
    };
    await persistPunches([...punches, record]);
    setFeedback({ name: emp.name, action: nextAction, time: new Date(), photo, hasLocation: !!loc, outOfRange });
    setPin("");
    setTimeout(() => setFeedback(null), 3200);
  };

  const submitPin = async (fullPin) => {
    const emp = storeEmployees.find(e => e.pin === fullPin);
    if (!emp) { setError("PIN não encontrado nesta loja."); setPin(""); return; }

    const last = lastActionFor(emp.id);
    const nextAction = last && last.action === "entrada" ? "saida" : "entrada";
    const issue = checkTimingIssue(emp, nextAction);
    if (issue) {
      setConfirmState({ emp, nextAction, ...issue });
      setPin("");
      return;
    }
    setPin("");
    await finalizePunch(emp, nextAction, null);
  };

  const confirmEarly = async () => {
    const { emp, nextAction, type } = confirmState;
    setConfirmState(null);
    const overrideMap = {
      early_entry: "hora_extra_autorizada",
      late_entry: "entrada_atrasada_confirmada",
      early_exit: "saida_antecipada_confirmada",
    };
    await finalizePunch(emp, nextAction, overrideMap[type] || null);
  };
  const cancelEarly = () => setConfirmState(null);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <video ref={videoRef} muted playsInline style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />

      {confirmState ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{
            textAlign: "center", animation: "popIn 0.25s ease-out", background: COLORS.surface,
            border: `1px solid ${COLORS.amber}`, borderRadius: 20, padding: "36px 30px", width: "100%", maxWidth: 360,
          }}>
            <AlertCircle size={36} color={COLORS.amber} style={{ marginBottom: 14 }} />
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700, marginBottom: 8 }}>{confirmState.emp.name}</div>
            {confirmState.type === "early_entry" ? (
              <>
                <div style={{ fontSize: 14, marginBottom: 6 }}>Ainda é muito cedo para bater o ponto.</div>
                <div style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 18 }}>
                  Sua entrada é às <b style={{ color: COLORS.text }}>{confirmState.expected}</b>. Você tem autorização para hora extra?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button onClick={confirmEarly} style={{ ...ghostBtnStyle, justifyContent: "center", background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>
                    Sim, tenho autorização
                  </button>
                  <button onClick={cancelEarly} style={{ ...ghostBtnStyle, justifyContent: "center" }}>Não, vou aguardar</button>
                </div>
              </>
            ) : confirmState.type === "late_entry" ? (
              <>
                <div style={{ fontSize: 14, marginBottom: 6 }}>Você está entrando bem depois do horário.</div>
                <div style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 18 }}>
                  Sua entrada era às <b style={{ color: COLORS.text }}>{confirmState.expected}</b> ({confirmState.diff}min de atraso). Confirma essa entrada?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button onClick={confirmEarly} style={{ ...ghostBtnStyle, justifyContent: "center", background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>
                    Sim, confirmar entrada
                  </button>
                  <button onClick={cancelEarly} style={{ ...ghostBtnStyle, justifyContent: "center" }}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14, marginBottom: 6 }}>Você está saindo antes do horário.</div>
                <div style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 18 }}>
                  Sua saída é às <b style={{ color: COLORS.text }}>{confirmState.expected}</b>. Confirma a saída antecipada?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button onClick={confirmEarly} style={{ ...ghostBtnStyle, justifyContent: "center", background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>
                    Sim, confirmar saída
                  </button>
                  <button onClick={cancelEarly} style={{ ...ghostBtnStyle, justifyContent: "center" }}>Não, continuar trabalhando</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : capturing ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <div style={{ animation: "pulse 1s ease-in-out infinite", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <Camera size={30} color={COLORS.amber} />
            <MapPin size={22} color={COLORS.textDim} />
          </div>
          <div style={{ color: COLORS.textDim, fontSize: 13 }}>Registrando foto e localização…</div>
        </div>
      ) : feedback ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{
            textAlign: "center", animation: "popIn 0.25s ease-out",
            background: COLORS.surface, border: `1px solid ${feedback.action === "entrada" ? COLORS.teal : COLORS.amber}`,
            borderRadius: 20, padding: "36px 32px", width: "100%",
          }}>
            {feedback.photo ? (
              <img src={feedback.photo} alt="" style={{ width: 84, height: 64, objectFit: "cover", borderRadius: 12, margin: "0 auto 16px", display: "block", border: `2px solid ${COLORS.border}` }} />
            ) : (
              <div style={{
                width: 72, height: 72, borderRadius: "50%", margin: "0 auto 20px",
                background: feedback.action === "entrada" ? "rgba(78,156,147,0.15)" : "rgba(232,163,57,0.15)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><Check size={34} color={feedback.action === "entrada" ? COLORS.teal : COLORS.amber} /></div>
            )}
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, marginBottom: 6 }}>{feedback.name}</div>
            <div style={{ color: feedback.action === "entrada" ? COLORS.teal : COLORS.amber, fontWeight: 600, fontSize: 14, textTransform: "uppercase", letterSpacing: 1 }}>
              {feedback.action === "entrada" ? "Entrada registrada" : "Saída registrada"}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 28, marginTop: 12 }}>{fmtTime(feedback.time)}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12, fontSize: 11, color: COLORS.textDim }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <MapPin size={12} color={feedback.hasLocation ? COLORS.teal : COLORS.textDim} />
                {feedback.hasLocation ? "Localização registrada" : "Sem localização"}
              </span>
              {feedback.outOfRange && (
                <span style={{ color: COLORS.red, display: "flex", alignItems: "center", gap: 4 }}>
                  <AlertCircle size={12} /> Fora da área da loja
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: "20px 0" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 44, fontWeight: 700 }}>{fmtTime(now)}</div>
            <div style={{ color: COLORS.textDim, fontSize: 14, marginTop: 4 }}>{fmtDate(now)}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 10 }}>Digite seu PIN</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{
                  width: 44, height: 54, borderRadius: 10, border: `1.5px solid ${error ? COLORS.red : COLORS.border}`,
                  background: COLORS.surface, display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT_MONO, fontSize: 24, fontWeight: 700,
                }}>{pin[i] ? "•" : ""}</div>
              ))}
            </div>
            {error && <div style={{ color: COLORS.red, fontSize: 13, marginTop: 10, display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}><AlertCircle size={14} /> {error}</div>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 68px)", gap: 12 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => <NumKey key={d} label={d} onClick={() => handleDigit(d)} />)}
            <button onClick={handleClear} style={{ ...numKeyStyle, color: COLORS.textDim, fontSize: 13 }}>Limpar</button>
            <NumKey label="0" onClick={() => handleDigit("0")} />
            <div />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.textDim, fontSize: 11 }}>
            <Camera size={12} /> Ao bater o ponto, uma foto e a localização são registradas
          </div>
          <button onClick={onRequest} style={{ ...ghostBtnStyle, marginTop: 4 }}>
            <FileText size={14} /> Solicitar ajuste / enviar atestado
          </button>
          {storeEmployees.length === 0 && (
            <div style={{ color: COLORS.textDim, fontSize: 13, textAlign: "center", maxWidth: 280 }}>
              Nenhum funcionário cadastrado nesta loja ainda. Entre em Admin para cadastrar.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const numKeyStyle = {
  width: 68, height: 68, borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
  color: COLORS.text, fontFamily: FONT_MONO, fontSize: 22, fontWeight: 700, transition: "background 0.1s, transform 0.1s",
};
function NumKey({ label, onClick }) {
  const [active, setActive] = useState(false);
  return (
    <button onClick={onClick} onMouseDown={() => setActive(true)} onMouseUp={() => setActive(false)} onMouseLeave={() => setActive(false)}
      style={{ ...numKeyStyle, background: active ? COLORS.amberDim : COLORS.surface, transform: active ? "scale(0.96)" : "scale(1)" }}>
      {label}
    </button>
  );
}

// ---------- Request form (ajuste / atestado) ----------
function RequestForm({ employees, store, persistRequests, requests, onDone }) {
  const [pin, setPin] = useState("");
  const [empFound, setEmpFound] = useState(null);
  const [pinError, setPinError] = useState("");
  const [type, setType] = useState(REQUEST_TYPES[0].id);
  const [date, setDate] = useState(fmtDateKey(new Date()));
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState(null);
  const [photoName, setPhotoName] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef(null);

  const checkPin = () => {
    const emp = employees.find(e => e.pin === pin && e.store === store && e.active !== false);
    if (!emp) { setPinError("PIN não encontrado nesta loja."); setEmpFound(null); return; }
    setPinError(""); setEmpFound(emp);
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoName(file.name);
    const dataUrl = await resizeImageFile(file);
    setPhoto(dataUrl);
  };

  const submit = async () => {
    if (!empFound || !note.trim()) return;
    setSending(true);
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      employeeId: empFound.id, employeeName: empFound.name, store,
      type, date, note: note.trim(), photo: photo || null,
      status: "pendente", createdAt: new Date().toISOString(), adminNote: "",
    };
    await persistRequests([...requests, record]);
    setSending(false); setDone(true);
    setTimeout(onDone, 1800);
  };

  if (done) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <CheckCircle2 size={40} color={COLORS.teal} />
        <div style={{ fontWeight: 600 }}>Solicitação enviada</div>
        <div style={{ color: COLORS.textDim, fontSize: 13 }}>O administrador vai revisar em breve.</div>
      </div>
    );
  }

  if (!empFound) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <FileText size={26} color={COLORS.textDim} />
        <div style={{ color: COLORS.textDim, fontSize: 13 }}>Digite seu PIN para continuar</div>
        <input
          value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="PIN" style={{ ...selectStyle, width: 140, textAlign: "center", fontFamily: FONT_MONO, fontSize: 20, letterSpacing: 4 }}
        />
        {pinError && <div style={{ color: COLORS.red, fontSize: 12 }}>{pinError}</div>}
        <button onClick={checkPin} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>Continuar</button>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, animation: "slideUp 0.2s ease-out" }}>
      <div style={{ color: COLORS.textDim, fontSize: 13 }}>Solicitação de <b style={{ color: COLORS.text }}>{empFound.name}</b></div>

      <div>
        <div style={fieldLabel}>Tipo</div>
        <select value={type} onChange={e => setType(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
          {REQUEST_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      <div>
        <div style={fieldLabel}>Data relacionada</div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...selectStyle, width: "100%" }} />
      </div>

      <div>
        <div style={fieldLabel}>Descrição</div>
        <textarea
          value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder={type === "atestado" ? "Ex: atestado de 2 dias, motivo consulta médica" : "Explique o que precisa ser ajustado"}
          style={{ ...selectStyle, width: "100%", resize: "vertical", fontFamily: FONT_UI }}
        />
      </div>

      <div>
        <div style={fieldLabel}>{type === "atestado" ? "Foto do atestado" : "Foto (opcional)"}</div>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
        {photo ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src={photo} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
            <div style={{ fontSize: 12, color: COLORS.textDim, flex: 1 }}>{photoName}</div>
            <button onClick={() => { setPhoto(null); setPhotoName(""); }} style={{ background: "none", border: "none", color: COLORS.textDim }}><X size={16} /></button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} style={{ ...ghostBtnStyle, width: "100%", justifyContent: "center" }}>
            <ImageIcon size={14} /> Anexar foto
          </button>
        )}
      </div>

      <button
        onClick={submit} disabled={!note.trim() || sending}
        style={{
          ...ghostBtnStyle, justifyContent: "center", background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber,
          opacity: !note.trim() || sending ? 0.6 : 1, marginTop: 4,
        }}
      >
        <Send size={14} /> {sending ? "Enviando…" : "Enviar solicitação"}
      </button>
    </div>
  );
}

const fieldLabel = { fontSize: 12, color: COLORS.textDim, marginBottom: 6 };

// ---------- Admin login ----------
function AdminLogin({ adminPin, onSuccess, onCancel }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const handleDigit = (d) => {
    if (pin.length >= 6) return;
    const next = pin + d; setPin(next);
    if (next.length >= adminPin.length) {
      if (next === adminPin) onSuccess();
      else { setError(true); setTimeout(() => { setPin(""); setError(false); }, 500); }
    }
  };
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
      <Lock size={28} color={COLORS.textDim} />
      <div style={{ color: COLORS.textDim, fontSize: 14 }}>PIN de administrador</div>
      <div style={{ display: "flex", gap: 10 }}>
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <div key={i} style={{ width: 16, height: 16, borderRadius: "50%", background: pin[i] ? (error ? COLORS.red : COLORS.amber) : "transparent", border: `1.5px solid ${error ? COLORS.red : COLORS.border}` }} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 60px)", gap: 10 }}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => (
          <button key={d} onClick={() => handleDigit(d)} style={{ ...numKeyStyle, width: 60, height: 60, fontSize: 18 }}>{d}</button>
        ))}
        <button onClick={() => setPin("")} style={{ ...numKeyStyle, width: 60, height: 60, fontSize: 12, color: COLORS.textDim }}>Limpar</button>
        <button onClick={() => handleDigit("0")} style={{ ...numKeyStyle, width: 60, height: 60, fontSize: 18 }}>0</button>
        <div />
      </div>
      <button onClick={onCancel} style={{ ...ghostBtnStyle, marginTop: 8 }}>Cancelar</button>
      <div style={{ color: COLORS.textDim, fontSize: 12, maxWidth: 260, textAlign: "center" }}>PIN padrão: 9999. Altere em Configurações depois de entrar.</div>
    </div>
  );
}

// ---------- Admin panel ----------
function AdminPanel({ employees, persistEmployees, punches, persistPunches, fetchLatestPunches, requests, persistRequests, leaves, persistLeaves, adminPin, persistAdminPin, storeCoords, persistStoreCoords, onExit }) {
  const [tab, setTab] = useState("records");
  const pendingCount = requests.filter(r => r.status === "pendente").length;
  const todayKey = fmtDateKey(new Date());
  const onLeaveToday = leaves.filter(l => l.startDate <= todayKey && l.endDate >= todayKey).length;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, animation: "slideUp 0.2s ease-out" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TabBtn icon={ListChecks} label="Registros" active={tab === "records"} onClick={() => setTab("records")} />
        <TabBtn icon={Inbox} label="Solicitações" badge={pendingCount} active={tab === "requests"} onClick={() => setTab("requests")} />
        <TabBtn icon={CalendarDays} label="Ausências" badge={onLeaveToday} active={tab === "leaves"} onClick={() => setTab("leaves")} />
        <TabBtn icon={FileSpreadsheet} label="Fechamento" active={tab === "closing"} onClick={() => setTab("closing")} />
        <TabBtn icon={Upload} label="Importar" active={tab === "import"} onClick={() => setTab("import")} />
        <TabBtn icon={Users} label="Funcionários" active={tab === "employees"} onClick={() => setTab("employees")} />
        <TabBtn icon={Lock} label="Config." active={tab === "settings"} onClick={() => setTab("settings")} />
      </div>
      {tab === "records" && <RecordsTab employees={employees} punches={punches} persistPunches={persistPunches} leaves={leaves} />}
      {tab === "requests" && <RequestsTab requests={requests} persistRequests={persistRequests} punches={punches} persistPunches={persistPunches} />}
      {tab === "leaves" && <LeavesTab employees={employees} leaves={leaves} persistLeaves={persistLeaves} />}
      {tab === "closing" && <ClosingTab employees={employees} punches={punches} leaves={leaves} />}
      {tab === "import" && <ImportTab employees={employees} punches={punches} persistPunches={persistPunches} fetchLatestPunches={fetchLatestPunches} />}
      {tab === "employees" && <EmployeesTab employees={employees} persistEmployees={persistEmployees} />}
      {tab === "settings" && <SettingsTab adminPin={adminPin} persistAdminPin={persistAdminPin} storeCoords={storeCoords} persistStoreCoords={persistStoreCoords} />}
    </div>
  );
}

function TabBtn({ icon: Icon, label, active, onClick, badge }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 90, justifyContent: "center",
      padding: "10px 8px", borderRadius: 9, fontSize: 13, fontWeight: 600,
      background: active ? COLORS.surfaceRaised : "transparent",
      border: `1px solid ${active ? COLORS.border : "transparent"}`, color: active ? COLORS.text : COLORS.textDim, position: "relative",
    }}>
      <Icon size={14} /> {label}
      {!!badge && (
        <span style={{ position: "absolute", top: -6, right: 2, background: COLORS.red, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 5px" }}>{badge}</span>
      )}
    </button>
  );
}

// ---- Records tab ----
function RecordsTab({ employees, punches, persistPunches, leaves }) {
  const [filterStore, setFilterStore] = useState("all");
  const [filterDate, setFilterDate] = useState(fmtDateKey(new Date()));
  const [expanded, setExpanded] = useState(null);

  const onLeaveThisDay = useMemo(() => {
    if (!filterDate) return [];
    return leaves
      .filter(l => l.startDate <= filterDate && l.endDate >= filterDate)
      .map(l => ({ ...l, emp: employees.find(e => e.id === l.employeeId) }))
      .filter(l => l.emp && (filterStore === "all" || l.emp.store === filterStore));
  }, [leaves, employees, filterDate, filterStore]);

  const rows = useMemo(() => punches
    .filter(p => filterStore === "all" || p.store === filterStore)
    .filter(p => !filterDate || fmtDateKey(new Date(p.at)) === filterDate)
    .sort((a, b) => new Date(b.at) - new Date(a.at)), [punches, filterStore, filterDate]);

  const removeRecord = async (id) => { await persistPunches(punches.filter(p => p.id !== id)); };

  const exportCSV = () => {
    const header = "Funcionário,Loja,Ação,Data,Hora,Fora da área\n";
    const body = [...punches].sort((a, b) => new Date(a.at) - new Date(b.at)).map(p => {
      const d = new Date(p.at);
      return `${p.employeeName},${STORES.find(s => s.id === p.store)?.label || p.store},${p.action === "entrada" ? "Entrada" : "Saída"},${fmtDate(d)},${fmtTime(d)},${p.outOfRange ? "Sim" : "Não"}`;
    }).join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "controle-de-ponto.csv"; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterStore} onChange={e => setFilterStore(e.target.value)} style={selectStyle}>
          <option value="all">Todas as lojas</option>
          {STORES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} style={selectStyle} />
        <button onClick={() => setFilterDate("")} style={{ ...ghostBtnStyle, padding: "8px 10px" }}>Todas as datas</button>
        <button onClick={exportCSV} style={{ ...ghostBtnStyle, marginLeft: "auto", color: COLORS.amber, borderColor: COLORS.amberDim }}><Download size={14} /> Exportar CSV</button>
      </div>

      {onLeaveThisDay.length > 0 && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Afastados nesta data</div>
          {onLeaveThisDay.map(l => {
            const t = LEAVE_TYPES.find(t => t.id === l.type);
            return (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: t?.color || COLORS.textDim }} />
                <span style={{ fontWeight: 600 }}>{l.emp.name}</span>
                <span style={{ color: COLORS.textDim }}>{t?.label}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "hidden" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: COLORS.textDim, fontSize: 13 }}>Nenhum registro para esse filtro.</div>
        ) : rows.map((p, i) => {
          const emp = employees.find(e => e.id === p.employeeId);
          const status = getScheduleStatus(p, emp);
          return (
          <div key={p.id} style={{ borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: p.photo || p.location ? "pointer" : "default" }}
              onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
              {p.photo ? (
                <img src={p.photo} alt="" style={{ width: 34, height: 34, borderRadius: 8, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.action === "entrada" ? COLORS.teal : COLORS.amber }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                  {p.employeeName}
                  {p.outOfRange && <AlertCircle size={12} color={COLORS.red} />}
                </div>
                <div style={{ color: COLORS.textDim, fontSize: 12 }}>
                  {STORES.find(s => s.id === p.store)?.label} · {p.action === "entrada" ? "Entrada" : "Saída"} · {fmtDate(new Date(p.at))}
                </div>
                {status && (
                  <div style={{ fontSize: 11, color: status.color, marginTop: 2, fontWeight: 600 }}>
                    {status.label}
                    {p.earlyOverride === "hora_extra_autorizada" && " · Hora extra autorizada pelo funcionário"}
                    {p.earlyOverride === "entrada_atrasada_confirmada" && " · Entrada atrasada confirmada pelo funcionário"}
                    {p.earlyOverride === "saida_antecipada_confirmada" && " · Confirmado pelo funcionário"}
                  </div>
                )}
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 15 }}>{fmtTime(new Date(p.at))}</div>
              <button onClick={(e) => { e.stopPropagation(); removeRecord(p.id); }} style={{ background: "none", border: "none", color: COLORS.textDim, padding: 4 }}><Trash2 size={15} /></button>
            </div>
            {expanded === p.id && (() => {
              return (
                <div style={{ padding: "0 14px 14px 58px", display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: COLORS.textDim, marginBottom: 4, textAlign: "center" }}>Cadastro</div>
                      {emp?.photo ? (
                        <img src={emp.photo} alt="" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
                      ) : (
                        <div style={{ width: 74, height: 74, borderRadius: 8, border: `1px dashed ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.textDim, textAlign: "center" }}>sem foto</div>
                      )}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: COLORS.textDim, marginBottom: 4, textAlign: "center" }}>No ponto</div>
                      {p.photo ? (
                        <img src={p.photo} alt="" style={{ width: 100, height: 74, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
                      ) : (
                        <div style={{ width: 100, height: 74, borderRadius: 8, border: `1px dashed ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.textDim }}>sem foto</div>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.textDim }}>
                    {p.location ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <MapPin size={12} color={p.outOfRange ? COLORS.red : COLORS.teal} />
                        {p.location.lat.toFixed(5)}, {p.location.lng.toFixed(5)}
                        {p.distance != null && ` · ${p.distance}m da loja`}
                      </div>
                    ) : "Sem localização registrada"}
                  </div>
                </div>
              );
            })()}
          </div>
          );
        })}
      </div>

      <DaySummary punches={punches} filterStore={filterStore} filterDate={filterDate} />
    </div>
  );
}

function DaySummary({ punches, filterStore, filterDate }) {
  if (!filterDate) return null;
  const dayPunches = punches.filter(p => (filterStore === "all" || p.store === filterStore) && fmtDateKey(new Date(p.at)) === filterDate);
  const byEmployee = {};
  dayPunches.forEach(p => { byEmployee[p.employeeId] = byEmployee[p.employeeId] || []; byEmployee[p.employeeId].push(p); });
  const summary = Object.entries(byEmployee).map(([empId, list]) => {
    const sorted = list.sort((a, b) => new Date(a.at) - new Date(b.at));
    let totalMin = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].action === "entrada" && sorted[i + 1].action === "saida") { totalMin += (new Date(sorted[i + 1].at) - new Date(sorted[i].at)) / 60000; i++; }
    }
    return { name: sorted[0].employeeName, totalMin, open: sorted[sorted.length - 1].action === "entrada" };
  });
  if (summary.length === 0) return null;
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Horas no dia</div>
      {summary.map((s, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
          <span>{s.name}{s.open ? " (em aberto)" : ""}</span>
          <span style={{ fontFamily: FONT_MONO }}>{fmtDuration(s.totalMin)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Requests tab ----
function RequestsTab({ requests, persistRequests, punches, persistPunches }) {
  const [filter, setFilter] = useState("pendente");
  const [expanded, setExpanded] = useState(null);

  const rows = useMemo(() => requests
    .filter(r => filter === "all" || r.status === filter)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [requests, filter]);

  const setStatus = async (id, status, adminNote = "") => {
    await persistRequests(requests.map(r => r.id === id ? { ...r, status, adminNote, resolvedAt: new Date().toISOString() } : r));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {[["pendente", "Pendentes"], ["aprovada", "Aprovadas"], ["rejeitada", "Rejeitadas"], ["all", "Todas"]].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} style={{
            ...ghostBtnStyle, padding: "6px 10px", fontSize: 12,
            background: filter === v ? COLORS.surfaceRaised : "transparent",
            borderColor: filter === v ? COLORS.border : "transparent",
            color: filter === v ? COLORS.text : COLORS.textDim,
          }}>{l}</button>
        ))}
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "hidden" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: COLORS.textDim, fontSize: 13 }}>Nenhuma solicitação aqui.</div>
        ) : rows.map((r, i) => (
          <div key={r.id} style={{ borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none", padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.employeeName}</div>
                <div style={{ color: COLORS.textDim, fontSize: 12 }}>
                  {REQUEST_TYPES.find(t => t.id === r.type)?.label} · {STORES.find(s => s.id === r.store)?.label} · ref. {fmtDate(new Date(r.date + "T00:00:00"))}
                </div>
              </div>
              <StatusPill status={r.status} />
            </div>
            <div style={{ fontSize: 13, marginTop: 8, color: COLORS.text }}>{r.note}</div>
            {r.photo && (
              <img src={r.photo} alt="" onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                style={{ marginTop: 8, width: expanded === r.id ? "100%" : 90, maxHeight: expanded === r.id ? 320 : 68, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}`, cursor: "pointer" }} />
            )}
            {r.adminNote && <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 6, fontStyle: "italic" }}>Nota admin: {r.adminNote}</div>}
            {r.status === "pendente" && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => setStatus(r.id, "aprovada")} style={{ ...ghostBtnStyle, color: COLORS.teal, borderColor: COLORS.teal, padding: "6px 10px", fontSize: 12 }}>
                  <CheckCircle2 size={13} /> Aprovar
                </button>
                <button onClick={() => setStatus(r.id, "rejeitada")} style={{ ...ghostBtnStyle, color: COLORS.red, borderColor: COLORS.red, padding: "6px 10px", fontSize: 12 }}>
                  <XCircle size={13} /> Rejeitar
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = { pendente: [COLORS.amber, "Pendente"], aprovada: [COLORS.teal, "Aprovada"], rejeitada: [COLORS.red, "Rejeitada"] };
  const [color, label] = map[status] || [COLORS.textDim, status];
  return <span style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 20, padding: "2px 8px", whiteSpace: "nowrap" }}>{label}</span>;
}

const selectStyle = { background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: FONT_UI };

// ---- Leaves tab (férias, atestados, licenças) ----
function LeavesTab({ employees, leaves, persistLeaves }) {
  const [showForm, setShowForm] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [type, setType] = useState(LEAVE_TYPES[0].id);
  const [startDate, setStartDate] = useState(fmtDateKey(new Date()));
  const [endDate, setEndDate] = useState(fmtDateKey(new Date()));
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState(null);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  const todayKey = fmtDateKey(new Date());

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(await resizeImageFile(file));
  };

  const add = async () => {
    if (!employeeId) { setErr("Selecione o funcionário."); return; }
    if (!startDate || !endDate || endDate < startDate) { setErr("Verifique as datas."); return; }
    const emp = employees.find(e => e.id === employeeId);
    await persistLeaves([...leaves, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      employeeId, employeeName: emp?.name || "", store: emp?.store, type, startDate, endDate, note: note.trim(),
      photo: photo || null, createdAt: new Date().toISOString(),
    }]);
    setEmployeeId(""); setType(LEAVE_TYPES[0].id); setStartDate(fmtDateKey(new Date())); setEndDate(fmtDateKey(new Date()));
    setNote(""); setPhoto(null); setErr(""); setShowForm(false);
  };

  const remove = async (id) => { await persistLeaves(leaves.filter(l => l.id !== id)); };

  const sorted = useMemo(() => [...leaves].sort((a, b) => b.startDate.localeCompare(a.startDate)), [leaves]);

  const statusOf = (l) => {
    if (l.endDate < todayKey) return "encerrada";
    if (l.startDate > todayKey) return "futura";
    return "ativa";
  };
  const statusColor = { ativa: COLORS.teal, futura: COLORS.textDim, encerrada: COLORS.border };
  const statusLabel = { ativa: "Em curso", futura: "Agendada", encerrada: "Encerrada" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ ...ghostBtnStyle, color: COLORS.amber, borderColor: COLORS.amberDim, alignSelf: "flex-start" }}>
          <Plus size={14} /> Registrar férias / licença
        </button>
      ) : (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
            <option value="">Selecione o funcionário</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({STORES.find(s => s.id === e.store)?.label})</option>)}
          </select>
          <select value={type} onChange={e => setType(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
            {LEAVE_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={fieldLabel}>Início</div>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...selectStyle, width: "100%" }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={fieldLabel}>Fim</div>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...selectStyle, width: "100%" }} />
            </div>
          </div>
          <textarea placeholder="Observação (opcional)" value={note} onChange={e => setNote(e.target.value)} rows={2} style={{ ...selectStyle, width: "100%", resize: "vertical", fontFamily: FONT_UI }} />
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
          {photo ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src={photo} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
              <button onClick={() => setPhoto(null)} style={{ background: "none", border: "none", color: COLORS.textDim }}><X size={16} /></button>
            </div>
          ) : (
            <button onClick={() => fileRef.current?.click()} style={{ ...ghostBtnStyle, justifyContent: "center" }}><ImageIcon size={14} /> Anexar documento (opcional)</button>
          )}
          {err && <div style={{ color: COLORS.red, fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={add} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>Salvar</button>
            <button onClick={() => { setShowForm(false); setErr(""); }} style={ghostBtnStyle}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "hidden" }}>
        {sorted.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: COLORS.textDim, fontSize: 13 }}>Nenhuma ausência registrada.</div>
        ) : sorted.map((l, i) => {
          const t = LEAVE_TYPES.find(t => t.id === l.type);
          const s = statusOf(l);
          return (
            <div key={l.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>
              {l.photo && <img src={l.photo} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{l.employeeName}</span>
                  <span style={{ fontSize: 11, color: t?.color, border: `1px solid ${t?.color}`, borderRadius: 20, padding: "1px 7px" }}>{t?.label}</span>
                  <span style={{ fontSize: 11, color: statusColor[s] }}>{statusLabel[s]}</span>
                </div>
                <div style={{ color: COLORS.textDim, fontSize: 12, marginTop: 2 }}>
                  {fmtDate(new Date(l.startDate + "T00:00:00"))} — {fmtDate(new Date(l.endDate + "T00:00:00"))}
                </div>
                {l.note && <div style={{ fontSize: 12, marginTop: 4 }}>{l.note}</div>}
              </div>
              <button onClick={() => remove(l.id)} style={{ background: "none", border: "none", color: COLORS.textDim, padding: 4 }}><Trash2 size={15} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Importar do Pontomais ----
function ImportTab({ employees, punches, persistPunches, fetchLatestPunches }) {
  const [parsed, setParsed] = useState(null); // { byName }
  const [mapping, setMapping] = useState({}); // name -> employeeId | ""
  const [fileError, setFileError] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError(""); setResult(null); setFileName(file.name);
    const text = await file.text();
    const out = parsePontomaisCSV(text);
    if (out.error) { setFileError(out.error); setParsed(null); return; }
    setParsed(out);
    const norm = (s) => s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const initialMapping = {};
    Object.keys(out.byName).forEach(name => {
      const target = norm(name);
      const exact = employees.find(e => norm(e.name) === target);
      const contains = !exact && employees.find(e => norm(e.name).includes(target) || target.includes(norm(e.name)));
      const match = exact || contains;
      initialMapping[name] = match ? match.id : "";
    });
    setMapping(initialMapping);
  };

  const runImport = async () => {
    if (!parsed) return;
    setImporting(true);
    // Busca a versão mais atual salva no banco antes de mesclar, para não sobrescrever
    // pontos batidos em outros dispositivos nesse meio-tempo.
    const latestPunches = await fetchLatestPunches();
    let newPunches = [];
    const existingKeys = new Set(latestPunches.filter(p => p.importedFrom === "pontomais").map(p => `${p.employeeId}|${p.at}`));

    Object.entries(parsed.byName).forEach(([name, dates]) => {
      const empId = mapping[name];
      if (!empId) return;
      const emp = employees.find(e => e.id === empId);
      if (!emp) return;
      dates.forEach((dt, idx) => {
        const action = idx % 2 === 0 ? "entrada" : "saida";
        const at = dt.toISOString();
        const key = `${empId}|${at}`;
        if (existingKeys.has(key)) return;
        existingKeys.add(key);
        newPunches.push({
          id: `${dt.getTime()}-${empId}-${idx}`,
          employeeId: empId, employeeName: emp.name, store: emp.store, action, at,
          photo: null, location: null, distance: null, outOfRange: false,
          importedFrom: "pontomais",
        });
      });
    });

    await persistPunches([...latestPunches, ...newPunches]);
    setImporting(false);
    setResult({ count: newPunches.length });
  };

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const totalNames = parsed ? Object.keys(parsed.byName).length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Importar histórico do Pontomais</div>
        <div style={{ fontSize: 12, color: COLORS.textDim }}>
          Exporte o relatório "Registros de Ponto" do Pontomais em CSV e envie o arquivo aqui.
        </div>
        <input ref={fileRef} type="file" onChange={handleFile} style={{ display: "none" }} />
        <button onClick={() => fileRef.current?.click()} style={{ ...ghostBtnStyle, alignSelf: "flex-start", color: COLORS.amber, borderColor: COLORS.amberDim }}>
          <Upload size={14} /> Selecionar arquivo CSV
        </button>
        {fileName && <div style={{ fontSize: 12, color: COLORS.textDim }}>Arquivo selecionado: {fileName}</div>}
        {fileError && <div style={{ color: COLORS.red, fontSize: 12 }}>{fileError}</div>}
      </div>

      {parsed && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Encontrei {totalNames} funcionário(s) no arquivo — mapeie cada nome para o cadastro correspondente
          </div>
          {Object.entries(parsed.byName).map(([name, dates]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  {name}
                  {!mapping[name] && <AlertCircle size={13} color={COLORS.amber} />}
                </div>
                <div style={{ fontSize: 11, color: COLORS.textDim }}>{dates.length} batidas</div>
              </div>
              <select value={mapping[name] || ""} onChange={e => setMapping(m => ({ ...m, [name]: e.target.value }))} style={{
                ...selectStyle,
                border: `1px solid ${mapping[name] ? COLORS.border : COLORS.amber}`,
              }}>
                <option value="">Não importar</option>
                {STORES.map(s => (
                  <optgroup key={s.id} label={s.label}>
                    {employees.filter(e => e.store === s.id).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          ))}

          <div style={{ color: COLORS.textDim, fontSize: 12 }}>{mappedCount} de {totalNames} serão importados.</div>

          <button
            onClick={runImport} disabled={importing || mappedCount === 0}
            style={{ ...ghostBtnStyle, justifyContent: "center", background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber, opacity: importing || mappedCount === 0 ? 0.6 : 1 }}
          >
            {importing ? "Importando…" : "Importar registros"}
          </button>

          {result && (
            <div style={{ color: COLORS.teal, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <CheckCircle2 size={15} /> {result.count} registros importados com sucesso.
            </div>
          )}
        </div>
      )}

      <div style={{ color: COLORS.textDim, fontSize: 11 }}>
        As batidas importadas entram sem foto e sem localização (o Pontomais não exporta essas informações), mas contam normalmente nas horas trabalhadas e no fechamento mensal. Importações repetidas do mesmo arquivo não duplicam os registros.
      </div>
    </div>
  );
}

// ---- Fechamento mensal (para contabilidade) ----
function ClosingTab({ employees, punches, leaves }) {
  const [month, setMonth] = useState(fmtDateKey(new Date()).slice(0, 7));
  const [storeFilter, setStoreFilter] = useState("all");

  const importedTotal = useMemo(() => punches.filter(p => p.importedFrom === "pontomais").length, [punches]);
  const importedThisMonth = useMemo(
    () => punches.filter(p => p.importedFrom === "pontomais" && p.at.slice(0, 7) === month).length,
    [punches, month]
  );

  const summary = useMemo(() => computeMonthlySummary(punches, leaves, employees, storeFilter, month), [punches, leaves, employees, storeFilter, month]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  }, [month]);

  const exportCSV = () => {
    const header = "Funcionário,Loja,Dias trabalhados,Horas trabalhadas,Atrasos,Saídas antecipadas,Dias de férias,Dias de atestado,Dias de licença maternidade,Dias de licença paternidade,Outras ausências (dias)\n";
    const body = summary.map(s => {
      const l = s.leaveDaysByType;
      return [
        s.emp.name,
        STORES.find(st => st.id === s.emp.store)?.label || s.emp.store,
        s.daysWorked,
        fmtDuration(s.totalMin).replace("h", ":").padEnd(5, "0"),
        s.lateCount,
        s.earlyLeaveCount,
        l.ferias || 0,
        l.atestado || 0,
        l.maternidade || 0,
        l.paternidade || 0,
        l.outro || 0,
      ].join(",");
    }).join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `fechamento-${month}${storeFilter !== "all" ? "-" + storeFilter : ""}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={selectStyle} />
        <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} style={selectStyle}>
          <option value="all">Todas as lojas</option>
          {STORES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button onClick={exportCSV} style={{ ...ghostBtnStyle, marginLeft: "auto", color: COLORS.amber, borderColor: COLORS.amberDim }}>
          <Download size={14} /> Exportar CSV para contabilidade
        </button>
      </div>
      <div style={{ color: COLORS.textDim, fontSize: 12, textTransform: "capitalize" }}>{monthLabel}</div>
      <div style={{ color: COLORS.textDim, fontSize: 11 }}>
        {importedTotal} registros importados do Pontomais no total ({importedThisMonth} neste mês).
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "auto" }}>
        {summary.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: COLORS.textDim, fontSize: 13 }}>Nenhum funcionário cadastrado.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: "left" }}>
                {["Funcionário", "Dias", "Horas", "Atrasos", "Saída ant.", "Férias", "Atestado", "Matern.", "Patern.", "Outras"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", color: COLORS.textDim, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.map(s => (
                <tr key={s.emp.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>{s.emp.name}</td>
                  <td style={{ padding: "8px 10px" }}>{s.daysWorked}</td>
                  <td style={{ padding: "8px 10px", fontFamily: FONT_MONO }}>{fmtDuration(s.totalMin)}</td>
                  <td style={{ padding: "8px 10px", color: s.lateCount ? COLORS.red : COLORS.textDim }}>{s.lateCount}</td>
                  <td style={{ padding: "8px 10px", color: s.earlyLeaveCount ? COLORS.amber : COLORS.textDim }}>{s.earlyLeaveCount}</td>
                  <td style={{ padding: "8px 10px" }}>{s.leaveDaysByType.ferias || "—"}</td>
                  <td style={{ padding: "8px 10px" }}>{s.leaveDaysByType.atestado || "—"}</td>
                  <td style={{ padding: "8px 10px" }}>{s.leaveDaysByType.maternidade || "—"}</td>
                  <td style={{ padding: "8px 10px" }}>{s.leaveDaysByType.paternidade || "—"}</td>
                  <td style={{ padding: "8px 10px" }}>{s.leaveDaysByType.outro || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ color: COLORS.textDim, fontSize: 11 }}>
        O CSV pode ser aberto direto no Excel e enviado por e-mail ou WhatsApp para a contabilidade.
      </div>
    </div>
  );
}

// ---- Employees tab ----
function EmployeesTab({ employees, persistEmployees }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(""); const [pin, setPin] = useState(""); const [store, setStore] = useState(STORES[0].id); const [err, setErr] = useState("");
  const [refPhoto, setRefPhoto] = useState(null);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const fileRef = useRef(null);

  const handleRefPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await resizeImageFile(file, 300, 300, 0.7);
    setRefPhoto(dataUrl);
  };

  const addEmployee = async () => {
    if (!name.trim()) { setErr("Informe o nome."); return; }
    if (!/^\d{4}$/.test(pin)) { setErr("PIN precisa ter 4 dígitos."); return; }
    if (employees.some(e => e.pin === pin && e.store === store)) { setErr("Esse PIN já está em uso nessa loja."); return; }
    await persistEmployees([...employees, { id: `${Date.now()}`, name: name.trim(), pin, store, active: true, photo: refPhoto || null, schedule: null }]);
    setName(""); setPin(""); setErr(""); setRefPhoto(null); setShowForm(false);
  };
  const toggleActive = async (id) => { await persistEmployees(employees.map(e => e.id === id ? { ...e, active: !(e.active !== false) } : e)); };
  const removeEmployee = async (id) => { await persistEmployees(employees.filter(e => e.id !== id)); };
  const saveSchedule = async (id, schedule) => {
    await persistEmployees(employees.map(e => e.id === id ? { ...e, schedule } : e));
    setEditingSchedule(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ ...ghostBtnStyle, color: COLORS.amber, borderColor: COLORS.amberDim, alignSelf: "flex-start" }}><Plus size={14} /> Novo funcionário</button>
      ) : (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept="image/*" capture="user" onChange={handleRefPhoto} style={{ display: "none" }} />
            <button onClick={() => fileRef.current?.click()} style={{
              width: 56, height: 56, borderRadius: 12, border: `1px dashed ${COLORS.border}`, background: COLORS.surfaceRaised,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0, overflow: "hidden", flexShrink: 0,
            }}>
              {refPhoto ? <img src={refPhoto} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Camera size={18} color={COLORS.textDim} />}
            </button>
            <div style={{ fontSize: 12, color: COLORS.textDim }}>Foto de referência (opcional, ajuda a conferir quem bateu o ponto)</div>
          </div>
          <input placeholder="Nome" value={name} onChange={e => setName(e.target.value)} style={{ ...selectStyle, width: "100%" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="PIN (4 dígitos)" value={pin} maxLength={4} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} style={{ ...selectStyle, flex: 1 }} />
            <select value={store} onChange={e => setStore(e.target.value)} style={selectStyle}>{STORES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </div>
          {err && <div style={{ color: COLORS.red, fontSize: 12 }}>{err}</div>}
          <div style={{ color: COLORS.textDim, fontSize: 11 }}>O horário de trabalho é configurado depois, na lista abaixo.</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={addEmployee} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>Salvar</button>
            <button onClick={() => { setShowForm(false); setErr(""); setRefPhoto(null); }} style={ghostBtnStyle}>Cancelar</button>
          </div>
        </div>
      )}

      {STORES.map(s => (
        <div key={s.id}>
          <div style={{ fontSize: 12, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0" }}>{s.label}</div>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "hidden" }}>
            {employees.filter(e => e.store === s.id).length === 0 ? (
              <div style={{ padding: 16, color: COLORS.textDim, fontSize: 13 }}>Nenhum funcionário cadastrado.</div>
            ) : employees.filter(e => e.store === s.id).map((e, i) => (
              <div key={e.id} style={{ borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", opacity: e.active === false ? 0.5 : 1 }}>
                  {e.photo ? (
                    <img src={e.photo} alt="" style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: COLORS.surfaceRaised, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Users size={15} color={COLORS.textDim} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{e.name}</div>
                    <div style={{ color: COLORS.textDim, fontSize: 12, fontFamily: FONT_MONO }}>PIN {e.pin}</div>
                    {e.schedule ? (
                      <div style={{ color: COLORS.teal, fontSize: 11, marginTop: 2 }}>
                        {formatScheduleSummary(e.schedule)}
                      </div>
                    ) : (
                      <div style={{ color: COLORS.textDim, fontSize: 11, marginTop: 2 }}>Sem horário definido</div>
                    )}
                  </div>
                  <button onClick={() => setEditingSchedule(editingSchedule === e.id ? null : e.id)} style={{ ...ghostBtnStyle, padding: "5px 9px", fontSize: 12 }}>
                    <Clock size={12} /> Horário
                  </button>
                  <button onClick={() => toggleActive(e.id)} style={{ ...ghostBtnStyle, padding: "5px 9px", fontSize: 12 }}>{e.active === false ? "Ativar" : "Desativar"}</button>
                  <button onClick={() => removeEmployee(e.id)} style={{ background: "none", border: "none", color: COLORS.textDim, padding: 4 }}><Trash2 size={15} /></button>
                </div>
                {editingSchedule === e.id && (
                  <ScheduleEditor employee={e} onSave={(sch) => saveSchedule(e.id, sch)} onCancel={() => setEditingSchedule(null)} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScheduleEditor({ employee, onSave, onCancel }) {
  const initialNorm = normalizeSchedule(employee.schedule);
  const [perDay, setPerDay] = useState(initialNorm?.perDay || {});
  const [tolerance, setTolerance] = useState(initialNorm?.tolerance ?? 10);

  const toggleDay = (d) => {
    setPerDay(prev => {
      if (prev[d]) {
        const next = { ...prev };
        delete next[d];
        return next;
      }
      return { ...prev, [d]: { entrada: "08:00", saida: "17:00" } };
    });
  };
  const updateDay = (d, field, value) => {
    setPerDay(prev => ({ ...prev, [d]: { ...prev[d], [field]: value } }));
  };
  const copyToAll = (d) => {
    const src = perDay[d];
    if (!src) return;
    setPerDay(prev => {
      const next = { ...prev };
      WEEK_ORDER.forEach(day => { if (next[day]) next[day] = { entrada: src.entrada, saida: src.saida }; });
      return next;
    });
  };

  return (
    <div style={{ padding: "0 14px 14px 14px", display: "flex", flexDirection: "column", gap: 10, background: COLORS.surfaceRaised }}>
      <div style={{ width: 110 }}>
        <div style={fieldLabel}>Tolerância (min)</div>
        <input type="number" value={tolerance} onChange={e => setTolerance(Number(e.target.value) || 0)} style={{ ...selectStyle, width: "100%" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {WEEK_ORDER.map(d => {
          const info = perDay[d];
          return (
            <div key={d} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => toggleDay(d)} style={{
                width: 44, height: 32, flexShrink: 0, borderRadius: 7, fontSize: 12, fontWeight: 600,
                background: info ? COLORS.amber : COLORS.surface,
                color: info ? "#1A1400" : COLORS.textDim,
                border: `1px solid ${info ? COLORS.amber : COLORS.border}`,
              }}>{WEEKDAYS[d]}</button>
              {info ? (
                <>
                  <input type="time" value={info.entrada} onChange={e => updateDay(d, "entrada", e.target.value)} style={{ ...selectStyle, width: 100 }} />
                  <span style={{ color: COLORS.textDim, fontSize: 12 }}>até</span>
                  <input type="time" value={info.saida} onChange={e => updateDay(d, "saida", e.target.value)} style={{ ...selectStyle, width: 100 }} />
                  <button onClick={() => copyToAll(d)} title="Copiar este horário para todos os dias marcados" style={{ background: "none", border: "none", color: COLORS.textDim, fontSize: 11, padding: 4 }}>
                    Copiar p/ todos
                  </button>
                </>
              ) : (
                <span style={{ color: COLORS.textDim, fontSize: 12 }}>Folga</span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button onClick={() => onSave({ perDay, tolerance })} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber }}>Salvar horário</button>
        <button onClick={onCancel} style={ghostBtnStyle}>Cancelar</button>
      </div>
      <div style={{ color: COLORS.textDim, fontSize: 11 }}>Tolerância: minutos de atraso/antecipação aceitos antes de marcar como fora do horário.</div>
    </div>
  );
}

// ---- Settings tab ----
function SettingsTab({ adminPin, persistAdminPin, storeCoords, persistStoreCoords }) {
  const [newPin, setNewPin] = useState(""); const [saved, setSaved] = useState(false);
  const [localCoords, setLocalCoords] = useState(storeCoords);
  const [locating, setLocating] = useState(null);

  const save = async () => {
    if (!/^\d{4,6}$/.test(newPin)) return;
    await persistAdminPin(newPin); setSaved(true); setNewPin(""); setTimeout(() => setSaved(false), 1800);
  };

  const useCurrentLocation = async (storeId) => {
    setLocating(storeId);
    const loc = await getLocation();
    if (loc) setLocalCoords(prev => ({ ...prev, [storeId]: { ...(prev[storeId] || {}), lat: loc.lat, lng: loc.lng, radius: prev[storeId]?.radius || 150 } }));
    setLocating(null);
  };
  const updateRadius = (storeId, radius) => setLocalCoords(prev => ({ ...prev, [storeId]: { ...(prev[storeId] || {}), radius: Number(radius) || 0 } }));
  const saveCoords = async () => { await persistStoreCoords(localCoords); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 }}>
        <div style={{ fontSize: 13, color: COLORS.textDim }}>Alterar PIN de administrador</div>
        <input placeholder="Novo PIN (4 a 6 dígitos)" value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, ""))} style={selectStyle} />
        <button onClick={save} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber, alignSelf: "flex-start" }}>Salvar novo PIN</button>
        {saved && <div style={{ color: COLORS.teal, fontSize: 12 }}>PIN atualizado.</div>}
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 420 }}>
        <div style={{ fontSize: 13, color: COLORS.textDim }}>Localização das lojas (para validar geolocalização do ponto)</div>
        {STORES.map(s => (
          <div key={s.id} style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{s.label}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={() => useCurrentLocation(s.id)} style={{ ...ghostBtnStyle, fontSize: 12, padding: "6px 10px" }}>
                <MapPin size={13} /> {locating === s.id ? "Obtendo…" : "Usar localização atual"}
              </button>
              {localCoords[s.id]?.lat && (
                <span style={{ fontSize: 11, color: COLORS.textDim, fontFamily: FONT_MONO }}>
                  {localCoords[s.id].lat.toFixed(5)}, {localCoords[s.id].lng.toFixed(5)}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 12, color: COLORS.textDim }}>Raio permitido</span>
              <input type="number" value={localCoords[s.id]?.radius ?? 150} onChange={e => updateRadius(s.id, e.target.value)} style={{ ...selectStyle, width: 80 }} />
              <span style={{ fontSize: 12, color: COLORS.textDim }}>metros</span>
            </div>
          </div>
        ))}
        <button onClick={saveCoords} style={{ ...ghostBtnStyle, background: COLORS.amber, color: "#1A1400", borderColor: COLORS.amber, alignSelf: "flex-start" }}>Salvar localizações</button>
        <div style={{ color: COLORS.textDim, fontSize: 11 }}>Dica: abra este app no tablet da loja, fique no local e clique em "Usar localização atual".</div>
      </div>

      <div style={{ color: COLORS.textDim, fontSize: 12, maxWidth: 420 }}>
        Os dados (funcionários, registros, solicitações e fotos) ficam salvos automaticamente e são compartilhados entre todos os dispositivos que abrirem este app.
      </div>
    </div>
  );
}
