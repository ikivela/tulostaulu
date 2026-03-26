  // Modal state for new match dialog
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
/**
 * Scoreboard with operator & public view (no backend)
 * - MP3 sound on end
 * - Cross-tab sync (BroadcastChannel / localStorage)
 * - NEW: Team-specific penalties (2:00 countdown), max 2 concurrent per team
 */

// ---------- Utilities ----------
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const formatMMSS = (totalSeconds) => {
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
};

// ---------- State ----------
const MAX_SECONDS = 59 * 60 + 59; 

const initialState = {
  seconds: 0,
  periodDuration: 15, // oletus 15 min (nyt minuutteina)
  running: false,
  direction: "up", // "up" | "down"
  period: 1, // 1..4
  home: 0,
  guest: 0,
  homeName: "Koti",
  guestName: "Vieras",
  penalties: {
    home: [], // each item = remaining seconds (int)
    guest: [],
  },
  timeout: { active: false, team: null, seconds: 30 },
  timeoutsUsed: { home: false, guest: false },
  breakActive: false,
  overtimeEnabled: false,
  overtimeDuration: 5, // jatkoajan pituus minuuteissa
  overtimeBreakDuration: 2, // jatkoajan tauon pituus minuuteissa
  overtime: false, // onko jatkoaika käynnissä
  // monotonic revision to avoid echo loops
  rev: 0,
};

function reducer(state, action) {
  // Lasketaan voimassa oleva eräaika: jatkoajalla käytetään overtimeDuration
  const effectivePeriodDuration = (state.overtime && state.period === 4)
    ? state.overtimeDuration
    : state.periodDuration;

  switch (action.type) {
    case "CLOCK_PLUS": {
      // Säädä pelikelloa sekunnin eteenpäin, vain kun aikalisä ei ole aktiivinen
      if (state.timeout && state.timeout.active) return state;
      const periodSeconds = effectivePeriodDuration * 60;
      return { ...state, seconds: clamp(state.seconds + 1, 0, periodSeconds), rev: state.rev + 1 };
    }
    case "CLOCK_MINUS": {
      // Säädä pelikelloa sekunnin taaksepäin, vain kun aikalisä ei ole aktiivinen
      if (state.timeout && state.timeout.active) return state;
      return { ...state, seconds: Math.max(0, state.seconds - 1), rev: state.rev + 1 };
    }
    case "SET_PERIOD_DURATION": {
      const duration = Math.max(1, Number(action.duration) || 20);
      return { ...state, periodDuration: duration };
    }
    case "TICK": {
      // Tick either main game clock (when running) OR timeout (when active) OR break
      const timeoutActive = !!(state.timeout && state.timeout.active);
      if (!(state.running || timeoutActive)) return state;

      // Timeout has priority: count it down exclusively
      if (timeoutActive) {
        const t = Math.max(0, (state.timeout.seconds ?? 30) - 1);
        const timeout = { ...state.timeout, seconds: t };
        if (t === 0) {
          return { ...state, timeout: { active: false, team: null, seconds: 30 }, rev: state.rev + 1 };
        }
        return { ...state, timeout };
      }

      // Break logic
      if (state.breakActive) {
        const nextSeconds = Math.max(0, state.seconds - 1);
        if (nextSeconds === 0) {
          // Break finished, reset breakActive and stop clock
            const nextPeriod = clamp((state.period ?? 1) + 1, 1, 5);
            return {
              ...state,
              seconds: 0,
              period: nextPeriod,
              overtime: state.overtime, // säilytetään overtime-lippu
              running: false,
              breakActive: false,
              direction: "up",
              timeoutsUsed: { home: false, guest: false },
              rev: state.rev + 1
            };
        }
        return { ...state, seconds: nextSeconds };
      }

      // Otherwise tick the main game clock
      const periodSeconds = effectivePeriodDuration * 60;
      const nextSeconds = state.direction === "down"
        ? clamp(state.seconds - 1, 0, periodSeconds)
        : clamp(state.seconds + 1, 0, periodSeconds);

      // Penalties tick down while the game clock runs
      const dec = (arr) => arr.map((s) => Math.max(0, s - 1)).filter((s) => s > 0);
      const nextPens = {
        home: dec(state.penalties.home),
        guest: dec(state.penalties.guest),
      };

      // Stop at terminal values depending on direction
      const reachedEnd = state.direction === "down"
        ? nextSeconds === 0
        : nextSeconds === periodSeconds;
      if (reachedEnd) {
        return { ...state, seconds: nextSeconds, penalties: nextPens, running: false, rev: state.rev + 1 };
      }
      return { ...state, seconds: nextSeconds, penalties: nextPens };
    }

    case "START":
      return state.running ? state : { ...state, running: true, rev: state.rev + 1 };
    case "STOP":
      return state.running ? { ...state, running: false, rev: state.rev + 1 } : state;

    case "RESET_CLOCK": {
      const next = clamp((state.period ?? 1) + 1, 1, 4);
      return {
        ...state,
        seconds: 0,
        period: next,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
      };
    }
    case "RESET_ALL":
      return {
        ...state,
        seconds: 0,
        running: false,
        direction: "up",
        period: 1,
        home: 0,
        guest: 0,
        homeName: "Koti",
        guestName: "Vieras",
        penalties: { home: [], guest: [] },
        timeout: { active: false, team: null, seconds: 30 },
        timeoutsUsed: { home: false, guest: false },
        breakActive: false,
        overtimeEnabled: false,
        overtime: false,
        overtimeDuration: 5,
        overtimeBreakDuration: 2,
        rev: state.rev + 1,
      };

    case "SET_OVERTIME_ENABLED":
      return { ...state, overtimeEnabled: !!action.value, rev: state.rev + 1 };
    case "SET_OVERTIME_DURATION": {
      const dur = Math.max(1, Math.min(60, Number(action.duration) || 5));
      return { ...state, overtimeDuration: dur, rev: state.rev + 1 };
    }
    case "SET_OVERTIME_BREAK_DURATION": {
      const dur = Math.max(1, Math.min(60, Number(action.duration) || 2));
      return { ...state, overtimeBreakDuration: dur, rev: state.rev + 1 };
    }
    case "START_OVERTIME_BREAK": {
      const minutes = Math.max(1, Number(action.minutes) || 2);
      return {
        ...state,
        seconds: minutes * 60,
        running: true,
        direction: "down",
        breakActive: true,
        overtime: true,
        rev: state.rev + 1,
      };
    }

    case "HOME_ADD":
      return { ...state, home: state.home + 1, rev: state.rev + 1 };
    case "HOME_SUB":
      return { ...state, home: Math.max(0, state.home - 1), rev: state.rev + 1 };
    case "GUEST_ADD":
      return { ...state, guest: state.guest + 1, rev: state.rev + 1 };
    case "GUEST_SUB":
      return { ...state, guest: Math.max(0, state.guest - 1), rev: state.rev + 1 };
    case "SET_HOME_NAME": {
      const name = String(action.name ?? "").trim();
      return { ...state, homeName: name.slice(0, 24), rev: state.rev + 1 };
    }
    case "SET_GUEST_NAME": {
      const name = String(action.name ?? "").trim();
      return { ...state, guestName: name.slice(0, 24), rev: state.rev + 1 };
    }

    case "PERIOD_NEXT": {
      const maxPeriod = state.overtimeEnabled ? 4 : 3;
      const next = clamp((state.period ?? 1) + 1, 1, maxPeriod);
      const isOvertime = state.overtimeEnabled && next === 4;
      return {
        ...state,
        period: next,
        overtime: isOvertime,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
      };
    }
    case "PERIOD_PREV": {
      const maxPeriod = state.overtimeEnabled ? 4 : 3;
      const prev = clamp((state.period ?? 1) - 1, 1, maxPeriod);
      return {
        ...state,
        period: prev,
        overtime: false,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
      };
    }

    case "START_BREAK": {
      const minutes = Math.max(1, Number(action.minutes) || 5);
      return {
        ...state,
        seconds: minutes * 60,
        running: true,
        direction: "down",
        breakActive: true,
        rev: state.rev + 1,
      };
    }

    // --- Penalties ---
    case "ADD_PENALTY": {
      const team = action.team; // 'home' | 'guest'
      if (!team || !["home", "guest"].includes(team)) return state;
      if (state.running) return state; // can add only when main clock is stopped
      const list = state.penalties[team];
      if (list.length >= 2) return state; // max 2
      const updated = { ...state.penalties, [team]: [...list, 120] }; // 2:00
      return { ...state, penalties: updated, rev: state.rev + 1 };
    }
    case "REMOVE_PENALTY": {
      const { team, index } = action;
      if (!team || !["home", "guest"].includes(team)) return state;
      const list = state.penalties[team];
      if (index < 0 || index >= list.length) return state;
      const nextList = list.slice(0, index).concat(list.slice(index + 1));
      return { ...state, penalties: { ...state.penalties, [team]: nextList }, rev: state.rev + 1 };
    }

    // --- Timeout ---
    case "START_TIMEOUT": {
      if (state.running) return state; // allow only when main clock stopped
      if (state.timeout && state.timeout.active) return state; // only one timeout at a time
      const team = action.team; // 'home' | 'guest'
      if (!team || !["home", "guest"].includes(team)) return state;
      if (state.timeoutsUsed && state.timeoutsUsed[team]) return state; // already used once
      return {
        ...state,
        timeout: { active: true, team, seconds: 30 },
        timeoutsUsed: { ...state.timeoutsUsed, [team]: true },
        rev: state.rev + 1,
      };
    }

    case "CANCEL_TIMEOUT": {
      if (!(state.timeout && state.timeout.active)) return state;
      return { ...state, timeout: { active: false, team: null, seconds: 30 }, rev: state.rev + 1 };
    }

    case "SET_STATE": {
      // Trusted remote state (from BroadcastChannel/localStorage). Ignore stale.
      const incoming = action.payload;
      if (incoming.rev == null) return state;
      if (incoming.rev <= state.rev) return state;
      return { ...incoming };
    }

    default:
      return state;
  }
}

// ---------- Cross-tab sync (BroadcastChannel + localStorage fallback) ----------
function useCrossTabSync(state, dispatch) {
  const channelRef = useRef(null);
  const role = useMemo(() => new URLSearchParams(window.location.search).get("role"), []);
  const isOperator = role !== "display"; // publish only from operator tab

  useEffect(() => {
    let bc = null;
    if ("BroadcastChannel" in window) {
      bc = new BroadcastChannel("scoreboard_v1");
      channelRef.current = bc;
      bc.onmessage = (ev) => dispatch({ type: "SET_STATE", payload: ev.data });
    } else {
      // Fallback via localStorage events
      const onStorage = (e) => {
        if (e.key !== "scoreboard_sync") return;
        try {
          const data = JSON.parse(e.newValue);
          if (data) dispatch({ type: "SET_STATE", payload: data });
        } catch {}
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
    return () => {
      if (bc) bc.close();
    };
  }, [dispatch]);

  // Publish on ANY state change, but only from operator tab to avoid echo loops
  useEffect(() => {
    if (!isOperator) return; // display tabs never publish
    const payloadObj = { ...state, _src: "operator" };
    const payloadStr = JSON.stringify(payloadObj);
    if (channelRef.current) {
      channelRef.current.postMessage(payloadObj);
    } else {
      try {
        localStorage.setItem("scoreboard_sync", payloadStr);
      } catch {}
    }
  }, [state, isOperator]);
}

// ---------- Timer loop ----------
function useGameLoop(state, dispatch) {
  const active = state.running || (state.timeout && state.timeout.active);
  const lastTickRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    let rafId;
    let lastTick = Date.now();
    lastTickRef.current = lastTick;
    //let lastLogTick = lastTick;
    const tick = () => {
      const now = Date.now();
      if (now - lastTickRef.current >= 1000) {
        //const drift = now - lastTickRef.current - 1000;
        //console.log(`Kellon sekuntiväli: ${(now - lastLogTick)/1000}s, heitto: ${drift}ms, sekunnit: ${new Date().toLocaleTimeString()}`);
        //lastLogTick = now;
        lastTickRef.current += 1000;
        dispatch({ type: "TICK" });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [active, dispatch]);
}


// ---------- Sound (MP3 via <audio>) ----------
function useAudio({ src, volume = 1, enabled = true } = {}) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    if (!src) return;
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = clamp(volume, 0, 1);
    audioRef.current = audio;
    return () => {
      // best-effort cleanup
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, [src, enabled, volume]);

  const play = async () => {
    if (!enabled || !audioRef.current) return;
    try {
      await audioRef.current.play();
    } catch (_) {}
  };

  return { play };
}

// Trigger MP3 exactly once when reaching terminal time (per tab if enabled)
function useEndOfTimeSound(state, { enabled = true, onlyOperator = true, src, volume = 1 } = {}) {
  const { play } = useAudio({ src, volume, enabled });
  const playedForRev = useRef(null);
  const prevTimeoutActive = useRef(false);
  const prevTimeoutTeam = useRef(null);
  const role = useMemo(() => new URLSearchParams(window.location.search).get("role"), []);
  const isOperator = role !== "display";

  // Reset guard when moving away from terminal values for the main clock
  useEffect(() => {
    if (state.direction === "down" && state.seconds !== 0) playedForRev.current = null;
    if (state.direction === "up" && state.seconds !== MAX_SECONDS) playedForRev.current = null;
  }, [state.seconds, state.direction]);

  useEffect(() => {
    const shouldPlayHere = onlyOperator ? isOperator : true;
    if (!shouldPlayHere || !enabled) return;

    // Lasketaan voimassa oleva eräaika (jatkoajalla overtimeDuration)
    const effectiveDuration = (state.overtime && state.period === 4)
      ? state.overtimeDuration
      : state.periodDuration;
    const periodSeconds = effectiveDuration * 60;
    const hitMainEnd = state.direction === "down"
      ? state.seconds === 0
      : state.seconds === periodSeconds;

    // 2) Timeout end condition: detect transition active -> inactive
    const timeoutActive = !!(state.timeout && state.timeout.active);
    const timeoutEndedNow = prevTimeoutActive.current && !timeoutActive;

    // Soitetaan summeri kun erä päättyy, aikalisä päättyy, tai erätauko päättyy
    if (hitMainEnd && playedForRev.current !== state.rev) {
      playedForRev.current = state.rev;
      play();
    }
    if (timeoutEndedNow && prevTimeoutTeam.current !== null) {
      play();
    }
    if (state.breakActive === false && prevTimeoutActive.current === true && state.seconds === 0) {
      play();
    }

    prevTimeoutActive.current = timeoutActive;
    prevTimeoutTeam.current = state.timeout && state.timeout.active ? state.timeout.team : null;
    }, [state.seconds, state.direction, state.rev, state.timeout, state.breakActive, enabled, isOperator, onlyOperator, play, state.periodDuration, state.overtime, state.overtimeDuration, state.period]);
}

// ---------- Views ----------
function OperatorView(props) {
  const skipBreakEndSoundRef = useRef(false);
  const { state, dispatch, soundOn, setSoundOn, soundUrl, volume, setVolume } = props;
  const prevBreakActive = useRef(state.breakActive);
  useEffect(() => {
    if (prevBreakActive.current && !state.breakActive && state.seconds === 0 && !skipBreakEndSoundRef.current) {
      try {
        const a = new Audio(soundUrl ?? "buzzer.mp3");
        a.volume = Number.isFinite(volume) ? volume : 1;
        a.play().catch(() => {});
      } catch {}
    }
    prevBreakActive.current = state.breakActive;
    if (state.breakActive) skipBreakEndSoundRef.current = false;
  }, [state.breakActive, state.seconds, soundUrl, volume]);
  const [showNewMatchModal, setShowNewMatchModal] = useState(false);
  const [showTimeoutModal, setShowTimeoutModal] = useState(null); // null tai "home"/"guest"
  const handleNewMatch = () => {
    skipBreakEndSoundRef.current = true;
    setShowNewMatchModal(true);
  };
  const canAddHomePenalty = !state.running && state.penalties.home.length < 2;
  const canAddGuestPenalty = !state.running && state.penalties.guest.length < 2;

  const effectivePeriodDuration = (state.overtime && state.period === 4)
    ? state.overtimeDuration
    : state.periodDuration;
  const periodSeconds = effectivePeriodDuration * 60;
  const periodFinished = !state.running && !state.breakActive && ((state.direction === "down" && state.seconds === 0) || (state.direction === "up" && state.seconds === periodSeconds));

  const [breakMinutes, setBreakMinutes] = useState(2);
  const [showBreakModal, setShowBreakModal] = useState(false);

  useEffect(() => {
    if (periodFinished) {
      try {
        const a = new Audio(props.soundUrl ?? "buzzer.mp3");
        a.volume = Number.isFinite(props.volume) ? props.volume : 1;
        a.play().catch(() => {});
      } catch {}
      const isTied = state.home === state.guest;
      const isAfterPeriod3 = state.period === 3;
      const isOvertime = state.overtime && state.period === 4;
      if (isOvertime) {
      } else if (isAfterPeriod3 && state.overtimeEnabled && !isTied) {
      } else if (isAfterPeriod3 && !state.overtimeEnabled) {
      } else {
        setShowBreakModal(true);
      }
    }
  }, [periodFinished, props.soundUrl, props.volume, state.home, state.guest, state.period, state.overtimeEnabled, state.overtime]);

  // JSON-asetusten tuonti
  const fileInputRef = useRef(null);
  const handleImportSettings = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const settings = JSON.parse(ev.target.result);
        if (settings.periodDuration) dispatch({ type: "SET_PERIOD_DURATION", duration: settings.periodDuration });
        if (settings.breakMinutes) setBreakMinutes(Math.max(1, Math.min(60, Number(settings.breakMinutes) || 2)));
        if (settings.homeName) dispatch({ type: "SET_HOME_NAME", name: settings.homeName });
        if (settings.guestName) dispatch({ type: "SET_GUEST_NAME", name: settings.guestName });
        if (settings.overtimeEnabled !== undefined) dispatch({ type: "SET_OVERTIME_ENABLED", value: !!settings.overtimeEnabled });
        if (settings.overtimeDuration) dispatch({ type: "SET_OVERTIME_DURATION", duration: settings.overtimeDuration });
        if (settings.overtimeBreakDuration) dispatch({ type: "SET_OVERTIME_BREAK_DURATION", duration: settings.overtimeBreakDuration });
      } catch {
        alert("Virheellinen JSON-tiedosto");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [dispatch]);

  const clockDisabled = state.running || !!(state.timeout && state.timeout.active);
  const timeoutDisabledHome = state.running || !!(state.timeout && state.timeout.active) || !!(state.timeoutsUsed && state.timeoutsUsed.home) || state.seconds === 0 || state.seconds === periodSeconds;
  const timeoutDisabledGuest = state.running || !!(state.timeout && state.timeout.active) || !!(state.timeoutsUsed && state.timeoutsUsed.guest) || state.seconds === 0 || state.seconds === periodSeconds;

  return (
    <div className="container py-4">
      {/* Asetukset */}
      <div className="card mb-3">
        <div className="card-header d-flex justify-content-between align-items-center">
          <span className="fw-semibold">⚙️ Asetukset</span>
          <div>
            <input type="file" accept=".json" ref={fileInputRef} onChange={handleImportSettings} className="d-none" />
            <button className="btn btn-sm btn-outline-secondary" onClick={() => fileInputRef.current?.click()}>
              📂 Tuo asetukset (JSON)
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-auto">
              <label className="form-label mb-0">Eräajan pituus (min)</label>
              <input type="number" className="form-control" min={1} max={60} value={state.periodDuration}
                onChange={e => dispatch({ type: "SET_PERIOD_DURATION", duration: e.target.value })} style={{ width: 90 }} />
            </div>
            <div className="col-auto">
              <label className="form-label mb-0">Erätauon pituus (min)</label>
              <input type="number" className="form-control" min={1} max={60} value={breakMinutes}
                onChange={e => setBreakMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 2)))} style={{ width: 90 }} />
            </div>
            <div className="col-auto d-flex align-items-end">
              <div className="form-check">
                <input className="form-check-input" type="checkbox" checked={state.overtimeEnabled} id="overtimeCheck"
                  onChange={e => dispatch({ type: "SET_OVERTIME_ENABLED", value: e.target.checked })} />
                <label className="form-check-label" htmlFor="overtimeCheck">Jatkoaika</label>
              </div>
            </div>
            {state.overtimeEnabled && (
              <>
                <div className="col-auto">
                  <label className="form-label mb-0">JA pituus (min)</label>
                  <input type="number" className="form-control" min={1} max={60} value={state.overtimeDuration}
                    onChange={e => dispatch({ type: "SET_OVERTIME_DURATION", duration: e.target.value })} style={{ width: 90 }} />
                </div>
                <div className="col-auto">
                  <label className="form-label mb-0">JA tauon pituus (min)</label>
                  <input type="number" className="form-control" min={1} max={60} value={state.overtimeBreakDuration}
                    onChange={e => dispatch({ type: "SET_OVERTIME_BREAK_DURATION", duration: e.target.value })} style={{ width: 90 }} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Kello */}
      <div className="text-center mb-3">
        <div style={{ fontSize: 80, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
          {formatMMSS((state.timeout && state.timeout.active) ? state.timeout.seconds : state.seconds)}
        </div>
        {state.breakActive && (
          <div className="text-danger fs-3 fw-bold mb-2">Tauko</div>
        )}
        <div className="d-flex justify-content-center gap-2 mb-2">
          <button className="btn btn-primary btn-lg" disabled={clockDisabled || state.seconds <= 0}
            onClick={() => dispatch({ type: "CLOCK_MINUS" })} title="Vähennä kellosta sekunti">−</button>
          <button className="btn btn-primary btn-lg" disabled={clockDisabled || state.seconds >= periodSeconds}
            onClick={() => dispatch({ type: "CLOCK_PLUS" })} title="Lisää kelloon sekunti">+</button>
        </div>
        <div className="d-flex justify-content-center gap-2">
          {state.running ? (
            <button className="btn btn-danger btn-lg" onClick={() => dispatch({ type: "STOP" })} title="Pysäytä pelikello">
              ⏸ Stop
            </button>
          ) : (
            <button className="btn btn-success btn-lg" disabled={!!(state.timeout && state.timeout.active) || periodFinished}
              onClick={() => dispatch({ type: "START" })} title="Käynnistä pelikello">
              ▶ Start
            </button>
          )}
          <button className="btn btn-primary btn-lg" disabled={state.running} onClick={handleNewMatch}>Uusi ottelu</button>
          <button className="btn btn-outline-primary btn-lg" disabled={state.running}
            onClick={() => window.open(`${window.location.pathname}?role=display`, "_blank")}>Avaa tulostaulu</button>
        </div>
      </div>

      {/* Pisteet ja erä */}
      <div className="row g-3 mb-3 justify-content-center">
        <div className="col-auto">
          <TeamBox editable name={state.homeName} onNameChange={(name) => dispatch({ type: "SET_HOME_NAME", name })}
            label={state.homeName} value={state.home}
            onAdd={() => dispatch({ type: "HOME_ADD" })} onSub={() => dispatch({ type: "HOME_SUB" })} />
        </div>
        <div className="col-auto">
          <div className="card text-center h-100">
            <div className="card-body d-flex flex-column justify-content-center">
              <div className="text-muted small">{(state.overtime && state.period === 4) ? "" : "Erä"}</div>
              <div className="fs-2 fw-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
                {(state.overtime && state.period === 4) ? "JA" : (state.period ?? 1)}
              </div>
              <div className="d-flex gap-1 justify-content-center mt-2">
                <button className="btn btn-sm btn-outline-primary" onClick={() => dispatch({ type: "PERIOD_PREV" })}
                  disabled={(state.period ?? 1) <= 1 || state.running}>−</button>
                <button className="btn btn-sm btn-outline-primary" onClick={() => dispatch({ type: "PERIOD_NEXT" })}
                  disabled={(state.period ?? 1) >= (state.overtimeEnabled ? 4 : 3) || state.running}>+</button>
              </div>
            </div>
          </div>
        </div>
        <div className="col-auto">
          <TeamBox editable name={state.guestName} onNameChange={(name) => dispatch({ type: "SET_GUEST_NAME", name })}
            label={state.guestName} value={state.guest}
            onAdd={() => dispatch({ type: "GUEST_ADD" })} onSub={() => dispatch({ type: "GUEST_SUB" })} />
        </div>
      </div>

      {/* Aikalisät */}
      <div className="row g-2 mb-3 justify-content-center">
        <div className="col-auto">
          <button className="btn btn-outline-warning" disabled={timeoutDisabledHome}
            onClick={() => setShowTimeoutModal("home")}
            title={state.timeoutsUsed?.home ? `${state.homeName} on käyttänyt aikalisän` : `Aikalisä ${state.homeName}`}>
            ⏱️ Aikalisä {state.homeName}
          </button>
        </div>
        <div className="col-auto">
          <button className="btn btn-outline-warning" disabled={timeoutDisabledGuest}
            onClick={() => setShowTimeoutModal("guest")}
            title={state.timeoutsUsed?.guest ? `${state.guestName} on käyttänyt aikalisän` : `Aikalisä ${state.guestName}`}>
            ⏱️ Aikalisä {state.guestName}
          </button>
        </div>
      </div>

      {/* Jäähyt */}
      <div className="row g-3 mb-3 justify-content-center">
        <div className="col-auto">
          <PenaltyEditor title={`${state.homeName} – jäähyt`} list={state.penalties.home} canAdd={canAddHomePenalty}
            onAdd={() => dispatch({ type: "ADD_PENALTY", team: "home" })}
            onRemove={(i) => dispatch({ type: "REMOVE_PENALTY", team: "home", index: i })} state={state} />
        </div>
        <div className="col-auto">
          <PenaltyEditor title={`${state.guestName} – jäähyt`} list={state.penalties.guest} canAdd={canAddGuestPenalty}
            onAdd={() => dispatch({ type: "ADD_PENALTY", team: "guest" })}
            onRemove={(i) => dispatch({ type: "REMOVE_PENALTY", team: "guest", index: i })} state={state} />
        </div>
      </div>

      {/* Ääni */}
      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap align-items-center gap-3">
          <button className="btn btn-outline-secondary" onClick={() => {
            const a = new Audio(soundUrl ?? "buzzer.mp3");
            a.volume = Number.isFinite(volume) ? volume : 1;
            a.play().catch(() => {});
          }}>🔔 Soita summeri</button>
          <div className="form-check">
            <input className="form-check-input" type="checkbox" checked={soundOn} id="soundCheck"
              onChange={(e) => setSoundOn(e.target.checked)} />
            <label className="form-check-label" htmlFor="soundCheck">Ääni päällä</label>
          </div>
          <div className="d-flex align-items-center gap-2">
            <label className="form-label mb-0">Äänenvoimakkuus</label>
            <input type="range" className="form-range" min={0} max={1} step={0.01}
              value={Number.isFinite(volume) ? volume : 1} onChange={(e) => setVolume(parseFloat(e.target.value))}
              style={{ width: 120 }} />
          </div>
        </div>
      </div>

      {/* Modaalit */}
      {showBreakModal && (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-body text-center py-4">
                {(() => {
                  const isTied = state.home === state.guest;
                  const isAfterPeriod3 = state.period === 3;
                  const showOvertime = state.overtimeEnabled && isAfterPeriod3 && isTied;
                  return showOvertime ? (
                    <>
                      <h5 className="mb-3">Tilanne tasan {state.home}–{state.guest}!</h5>
                      <p>Aloitetaanko tauko? ({state.overtimeBreakDuration} min)</p>
                      <button className="btn btn-warning btn-lg" onClick={() => {
                        dispatch({ type: "START_OVERTIME_BREAK", minutes: state.overtimeBreakDuration });
                        setShowBreakModal(false);
                      }}>Jatkoaika</button>
                    </>
                  ) : (
                    <>
                      <h5 className="mb-3">Erä {state.period} pelattu!</h5>
                      <p>Aloitetaanko tauko? ({breakMinutes} min)</p>
                      <button className="btn btn-success btn-lg" onClick={() => {
                        dispatch({ type: "START_BREAK", minutes: breakMinutes });
                        setShowBreakModal(false);
                      }}>Ok</button>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
      {showTimeoutModal && (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-body text-center py-4">
                <h5 className="mb-4">Aloitetaanko aikalisä joukkueelle {showTimeoutModal === "home" ? state.homeName : state.guestName}?</h5>
                <div className="d-flex gap-3 justify-content-center">
                  <button className="btn btn-warning btn-lg" onClick={() => { dispatch({ type: "START_TIMEOUT", team: showTimeoutModal }); setShowTimeoutModal(null); }}>Kyllä</button>
                  <button className="btn btn-secondary btn-lg" onClick={() => setShowTimeoutModal(null)}>Ei</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {showNewMatchModal && (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-body text-center py-4">
                <h5 className="mb-4">Aloitetaanko uusi ottelu?</h5>
                <div className="d-flex gap-3 justify-content-center">
                  <button className="btn btn-success btn-lg" onClick={() => { dispatch({ type: "RESET_ALL" }); setShowNewMatchModal(false); }}>Kyllä</button>
                  <button className="btn btn-danger btn-lg" onClick={() => setShowNewMatchModal(false)}>Ei</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center text-muted small mt-4">
        v{require('../package.json').version} | <a href="https://github.com/ikivela/tulostaulu" target="_blank" rel="noopener noreferrer" className="text-muted">GitHub</a>
      </footer>
    </div>
  );
}

function TeamBox({ label, value, onAdd, onSub, editable = false, name, onNameChange }) {
  return (
    <div className="card" style={{ minWidth: 220 }}>
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-2">
          {editable ? (
            <input type="text" className="form-control form-control-sm" value={name}
              onChange={(e) => onNameChange && onNameChange(e.target.value)} placeholder={label} style={{ maxWidth: 140 }} />
          ) : (
            <strong>{label}</strong>
          )}
          <span className="fs-3 fw-bold" style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-primary btn-sm" onClick={onAdd}>+1</button>
          <button className="btn btn-outline-primary btn-sm" onClick={onSub}>−1</button>
        </div>
      </div>
    </div>
  );
}

function PenaltyEditor({ title, list, canAdd, onAdd, onRemove, state }) {
  return (
    <div className="card" style={{ minWidth: 200 }}>
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <strong className="small">{title}</strong>
          <button className="btn btn-sm btn-outline-danger" onClick={onAdd} disabled={!canAdd}>+ 2:00</button>
        </div>
        {list.length === 0 ? (
          <div className="text-muted small">Ei jäähyjä</div>
        ) : (
          list.map((secs, i) => (
            <div key={i} className="d-flex justify-content-between align-items-center mb-1">
              <span style={{ fontVariantNumeric: "tabular-nums" }}>#{i + 1} – {formatMMSS(secs)}</span>
              <button className="btn btn-sm btn-outline-secondary" disabled={state.running} onClick={() => onRemove(i)}>Poista</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DisplayView({ state, soundUrl, volume }) {
  const [primed, setPrimed] = useState(false);
  // Paikallinen pistetieto: päivittyy vasta kun kello käy
  const [displayScores, setDisplayScores] = useState({ home: state.home, guest: state.guest });
  useEffect(() => {
    if (state.running) {
      setDisplayScores({ home: state.home, guest: state.guest });
    }
  }, [state.running, state.home, state.guest]);
  // RESET_ALL: nollaa näytön pisteet heti
  const prevHome = useRef(state.home);
  const prevGuest = useRef(state.guest);
  useEffect(() => {
    if (state.home === 0 && state.guest === 0 && (prevHome.current !== 0 || prevGuest.current !== 0)) {
      setDisplayScores({ home: 0, guest: 0 });
    }
    prevHome.current = state.home;
    prevGuest.current = state.guest;
  }, [state.home, state.guest]);
  return (
    <div style={{
      minHeight: "100vh",
      width: "100vw",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "4vh",
      background: "black",
      color: "white",
      textAlign: "center",
      position: "relative",
      overflow: "hidden",
    }}>
      
  <div style={{ fontSize: "24vw", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {formatMMSS((state.timeout && state.timeout.active) ? state.timeout.seconds : state.seconds)}
      </div>
      {state.breakActive && (
        <div style={{ fontSize: "6vw", color: "#ef4444", fontWeight: 700 }}>{state.overtime ? "Jatkoajan tauko" : "Erätauko"}</div>
      )}
  <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", justifyContent: "center", gap: "4vw" }}>
        {/* KOTI: pisteet + jäähyt */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          {(state.timeout && state.timeout.active && state.timeout.team === "home") && (
            <div style={{ width: "100%", height: 10, background: "#ef4444", borderRadius: 999, margin: "0 auto 8px auto" }} />
          )}
          <ScorePill label={state.homeName ? state.homeName.toUpperCase() : ""} value={displayScores.home} />
          <div style={{ marginTop: "1.5vw" }}>
            <PenaltyChips list={state.penalties.home} />
          </div>
        </div>
        {/* Keskellä erä */}
        <div style={{ display: "flex", alignItems: "center", alignSelf: "center", fontSize: "4vw", letterSpacing: 1, padding: "0 2vw" }}>
          {(state.overtime && state.period === 4) ? "JA" : `ERÄ ${state.period ?? 1}`}
        </div>
        {/* VIERAS: pisteet + jäähyt */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          {(state.timeout && state.timeout.active && state.timeout.team === "guest") && (
            <div style={{ width: "100%", height: 10, background: "#ef4444", borderRadius: 999, margin: "0 auto 8px auto" }} />
          )}
          <ScorePill label={state.guestName ? state.guestName.toUpperCase() : ""} value={displayScores.guest} />
          <div style={{ marginTop: "1.5vw" }}>
            <PenaltyChips list={state.penalties.guest} />
          </div>
        </div>
      </div>

      {false && !primed && (
        <button
          onClick={() => {
            // Prime audio on display tab for autoplay policies
            const a = new Audio(soundUrl ?? "buzzer.mp3");
            a.volume = Math.max(0, Math.min(1, volume ?? 1));
            a.play().then(() => { a.pause(); setPrimed(true); }).catch(() => {});
          }}
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            padding: "10px 14px",
            fontSize: 14,
            background: "#ffffff22",
            color: "white",
            border: "1px solid #ffffff44",
            borderRadius: 10,
          }}
          title="Ota ääni käyttöön yleisönäytössä"
        >
          🔊 Enable sound
        </button>
      )}
      </div>
  );
}

function PenaltyChips({ title, list }) {
  return (
    
<div style={{ display: "block" }}>
  {list.length === 0 ? (
    <span style={{ 
      border: "1px solid #fff",
      borderRadius: 10,
      padding: "8px 24px",
      fontVariantNumeric: "tabular-nums",
      fontSize: "5vw",
      opacity: 0
    }}>x</span>
  ) : (
    list.map((secs, i) => (
      <span key={i} style={{
        display: "block",
        border: "1px solid #fff",
        borderRadius: 10,
        padding: "8px 24px",
        fontVariantNumeric: "tabular-nums",
        color: "#ef4444",
        fontSize: "5vw",
        fontWeight: 700,
        background: "#fff2",
        marginBottom: 16 // Lisää väliä rivien väliin
      }}>{formatMMSS(secs)}</span>
    ))
  )}
</div>
  );
}

function ScorePill({ label, value }) {
  return (
    <div style={{ border: "2px solid #fff", borderRadius: 16, padding: "12px 20px", width: "30vw", boxSizing: "border-box" }}>
      <div style={{ marginBottom: 4, fontSize: 80 }}>{label}</div>
      <div style={{ fontSize: 200, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

// ---------- Root ----------
export default function App() {
  useEffect(() => {
    const role = new URLSearchParams(window.location.search).get("role");
    if (role === "display") {
      document.title = "Tulostaulu – Esitys";
    } else {
      document.title = "Tulostaulu";
    }
  }, []);
  // Lataa tallennettu state localStoragesta, jos löytyy
  const getInitialState = () => {
    try {
      const saved = localStorage.getItem("scoreboard_state_v1");
      if (saved) {
        const parsed = JSON.parse(saved);
        // Varmista, että parsed on olio ja sisältää tarvittavat kentät
        if (parsed && typeof parsed === "object" && parsed.seconds !== undefined) {
          return { ...initialState, ...parsed };
        }
      }
    } catch (e) {}
    return initialState;
  };
  const [state, dispatch] = useReducer(reducer, getInitialState());
  const [soundOn, setSoundOn] = useState(true); // per-tab toggle
  const [soundUrl, setSoundUrl] = useState("buzzer.mp3"); // place file in public/
  const [volume, setVolume] = useState(1);

  // ticking & cross-tab sync
  useGameLoop(state, dispatch);
  useCrossTabSync(state, dispatch);

  // Tallennetaan state localStorageen aina kun se muuttuu
  useEffect(() => {
    try {
      localStorage.setItem("scoreboard_state_v1", JSON.stringify(state));
    } catch (e) {}
  }, [state]);

  // end-of-time MP3 – play on both tabs (operator & display)
  useEndOfTimeSound(state, { enabled: soundOn, onlyOperator: false, src: soundUrl, volume });

  const role = useMemo(() => new URLSearchParams(window.location.search).get("role"), []);
  const isDisplay = role === "display";

  return (
    <div style={{ padding: isDisplay ? 0 : 24 }}>
      {isDisplay ? (
        <DisplayView state={state} soundUrl={soundUrl} volume={volume} />
      ) : (
        <OperatorView
          state={state}
          dispatch={dispatch}
          soundOn={soundOn}
          setSoundOn={setSoundOn}
          soundUrl={soundUrl}
          setSoundUrl={setSoundUrl}
          volume={volume}
          setVolume={setVolume}
        />
      )}
    </div>
  );
}
