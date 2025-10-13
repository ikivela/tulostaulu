import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";

/**
 * Scoreboard with operator & public view (no backend)
 * - Game clock (mm:ss), periods (1–4), goals, buzzer
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
  periodDuration: 20, // oletus 20 min (nyt minuutteina)
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
  // monotonic revision to avoid echo loops
  rev: 0,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_PERIOD_DURATION": {
      const duration = Math.max(1, Number(action.duration) || 20);
      return { ...state, periodDuration: duration };
    }
    case "TICK": {
      // Tick either main game clock (when running) OR timeout (when active)
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

      // Otherwise tick the main game clock
      const periodSeconds = state.periodDuration * 60;
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
        rev: state.rev + 1,
      };

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
      return { ...state, homeName: name ? name.slice(0, 24) : "Koti", rev: state.rev + 1 };
    }
    case "SET_GUEST_NAME": {
      const name = String(action.name ?? "").trim();
      return { ...state, guestName: name ? name.slice(0, 24) : "Vieras", rev: state.rev + 1 };
    };

    case "PERIOD_NEXT": {
      const next = clamp((state.period ?? 1) + 1, 1, 4);
      return {
        ...state,
        period: next,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
      };
    }
    case "PERIOD_PREV": {
      const prev = clamp((state.period ?? 1) - 1, 1, 4);
      return {
        ...state,
        period: prev,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
      };
    }
    case "SET_PERIOD": {
      const p = clamp(Number(action.to) || 1, 1, 4);
      return {
        ...state,
        period: p,
        running: false,
        direction: "up",
        timeoutsUsed: { home: false, guest: false },
        rev: state.rev + 1
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
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), 1000);
    return () => clearInterval(id);
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

    // 1) Main clock end conditions
    const periodSeconds = state.periodDuration * 60;
    const hitMainEnd = state.direction === "down"
      ? state.seconds === 0
      : state.seconds === periodSeconds;

    // 2) Timeout end condition: detect transition active -> inactive
    const timeoutActive = !!(state.timeout && state.timeout.active);
    const timeoutEndedNow = prevTimeoutActive.current && !timeoutActive;

    // Soitetaan summeri vain kun aikalisä päättyy, ei kun se alkaa
    if (hitMainEnd && playedForRev.current !== state.rev) {
      playedForRev.current = state.rev;
      play();
    }
    if (timeoutEndedNow && prevTimeoutTeam.current !== null) {
      play();
    }

    prevTimeoutActive.current = timeoutActive;
    prevTimeoutTeam.current = state.timeout && state.timeout.active ? state.timeout.team : null;
  }, [state.seconds, state.direction, state.rev, state.timeout, enabled, isOperator, onlyOperator, play]);
}

// ---------- Views ----------
function OperatorView(props) {
  const { state, dispatch, soundOn, setSoundOn, soundUrl, setSoundUrl, volume, setVolume } = props;
  const canAddHomePenalty = !state.running && state.penalties.home.length < 2;
  const canAddGuestPenalty = !state.running && state.penalties.guest.length < 2;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        textAlign: "center",
        position: "relative",
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Eräajan pituus (minuutteina):
          <input
            type="number"
            min={1}
            max={60}
            value={props.state.periodDuration}
            onChange={e => props.dispatch({ type: "SET_PERIOD_DURATION", duration: e.target.value })}
            style={{ width: 80 }}
          />
          <span style={{ fontSize: 12, color: '#666' }}>(esim. 20 = 20 min)</span>
        </label>
      </div>
      <div style={{ fontSize: 80, fontVariantNumeric: "tabular-nums" }}>{formatMMSS((state.timeout && state.timeout.active) ? state.timeout.seconds : state.seconds)}</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto auto auto auto", alignItems: "center", gap: 12 }}>
        {state.running ? (
          <button
            disabled={(state.timeout && state.timeout.active)}
            onClick={() => dispatch({ type: "STOP" })}
            style={{
              padding: "14px 22px",
              fontSize: 18,
              background: "#ef4444",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: ((state.timeout && state.timeout.active)) ? "not-allowed" : "pointer",
            }}
            title="Pysäytä pelikello"
          >
            ⏸ Stop
          </button>
        ) : (
          <button
            disabled={(state.timeout && state.timeout.active)}
            onClick={() => dispatch({ type: "START" })}
            style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running || (state.timeout && state.timeout.active)) ? "#9ca3af" : "#22c55e",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: ((state.timeout && state.timeout.active)) ? "not-allowed" : "pointer",
            }}
            title="Käynnistä pelikello"
          >
            ▶ Start
          </button>
  
        )}
        <button
          onClick={() => dispatch({ type: "RESET_CLOCK" })}
          disabled={state.running || (state.timeout && state.timeout.active)}
          style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running || (state.timeout && state.timeout.active)) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running || (state.timeout && state.timeout.active)) ? "not-allowed" : "pointer",
            }}
        >Uusi erä</button>
        <button onClick={() => dispatch({ type: "RESET_ALL" })}
          disabled={state.running}
          style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running) ? "not-allowed" : "pointer",
            }}>Uusi ottelu</button>
        <button onClick={() => window.open(`${window.location.pathname}?role=display`, "_blank")}
          style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running) ? "not-allowed" : "pointer",
            }}>Avaa esitys ikkuna</button>
      </div>

      {/* Scores */}
      <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", alignItems: "center", gap: 12 }}>
        <TeamBox
          editable
          name={state.homeName}
          onNameChange={(name) => dispatch({ type: "SET_HOME_NAME", name })}
          label={state.homeName}
          value={state.home}
          onAdd={() => dispatch({ type: "HOME_ADD" })}
          onSub={() => dispatch({ type: "HOME_SUB" })}
        />
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12}}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>Erä:</strong>
            <span style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }}>{state.period ?? 1}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button 
              onClick={() => dispatch({ type: "PERIOD_PREV" })} 
              disabled={(state.period ?? 1) <= 1 || state.running}
              style={{
                fontSize: 16,
                background: ((state.period ?? 1) <= 1 || state.running) ? "#9ca3af" : "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                cursor: "pointer",
              }}>-</button>
            <button 
              onClick={() => dispatch({ type: "PERIOD_NEXT" })} 
              disabled={(state.period ?? 1) >= 4 || state.running}
              style={{
                fontSize: 16,
                background: ((state.period ?? 1) >= 4 || state.running) ? "#9ca3af" : "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                cursor: "pointer",
              }}>+</button>
          </div>
        </div>
        <TeamBox
          editable
          name={state.guestName}
          onNameChange={(name) => dispatch({ type: "SET_GUEST_NAME", name })}
          label={state.guestName}
          value={state.guest}
          onAdd={() => dispatch({ type: "GUEST_ADD" })}
          onSub={() => dispatch({ type: "GUEST_SUB" })}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: 12}}>
          <button
            onClick={() => dispatch({ type: "START_TIMEOUT", team: "home" })}
            disabled={state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.home)}
            style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.home)) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.home)) ? "not-allowed" : "pointer",
            }}
            title={state.timeoutsUsed && state.timeoutsUsed.home ? "Koti on käyttänyt aikalisän" : "Aloita aikalisä (30s) kotijoukkueelle"}
          >
            ⏱️ Aikalisä Koti
          </button>
          <button
            onClick={() => dispatch({ type: "START_TIMEOUT", team: "guest" })}
            disabled={state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.guest)}
            style={{
              padding: "14px 22px",
              fontSize: 18,
              background: (state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.guest)) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running || (state.timeout && state.timeout.active) || (state.timeoutsUsed && state.timeoutsUsed.guest)) ? "not-allowed" : "pointer",
            }}
            title={state.timeoutsUsed && state.timeoutsUsed.guest ? "Vieras on käyttänyt aikalisän" : "Aloita aikalisä (30s) vierasjoukkueelle"}
          >
            ⏱️ Aikalisä Vieras
          </button>
        </div>

      {/* Penalties */}
      <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: 12 }}>
        <PenaltyEditor
          title="Koti – jäähyt"
          list={state.penalties.home}
          canAdd={canAddHomePenalty}
          onAdd={() => dispatch({ type: "ADD_PENALTY", team: "home" })}
          onRemove={(i) => dispatch({ type: "REMOVE_PENALTY", team: "home", index: i })}
          state={state}
        />
        <PenaltyEditor
          title="Vieras – jäähyt"
          list={state.penalties.guest}
          canAdd={canAddGuestPenalty}
          onAdd={() => dispatch({ type: "ADD_PENALTY", team: "guest" })}
          onRemove={(i) => dispatch({ type: "REMOVE_PENALTY", team: "guest", index: i })}
          state={state}
        />
      </div>
      <button
        onClick={() => {
          const a = new Audio(soundUrl ?? "buzzer.mp3");
          a.volume = Number.isFinite(volume) ? volume : 1;
          a.play().catch(() => {});
        }}
        style={{
              padding: "14px 22px",
              fontSize: 18,
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: "pointer",
            }}
        title="Test sound"
      >
        Soita summeri
      </button>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
        <input type="checkbox" checked={soundOn} onChange={(e) => setSoundOn(e.target.checked)} />
        Sound on
      </label>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        MP3 URL:
        <input
          style={{ width: 220 }}
          type="text"
          value={soundUrl ?? "buzzer.mp3"}
          onChange={(e) => setSoundUrl(e.target.value || "buzzer.mp3")}
          placeholder="buzzer.mp3"
        />
      </label>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={Number.isFinite(volume) ? volume : 1}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
        />
      </label>
    </div>
  );
}

function TeamBox({ label, value, onAdd, onSub, editable = false, name, onNameChange }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, minWidth: 260 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
        {editable ? (
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange && onNameChange(e.target.value)}
            placeholder={label}
            style={{ padding: 8, borderRadius: 8, minWidth: 140 }}
          />
        ) : (
          <strong>{label}</strong>
        )}
        <span style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button 
          onClick={onAdd}
          style={{
            fontSize: 16,
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            cursor: "pointer",
          }}>+1</button>
        <button 
          onClick={onSub}
          style={{
            fontSize: 16,
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            cursor: "pointer",
          }}>-1</button>
      </div>
    </div>
  );
}

function PenaltyEditor({ title, list, canAdd, onAdd, onRemove, state }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
        <strong>{title}</strong>
        <button 
          onClick={onAdd} 
          disabled={!canAdd}
          style={{
              fontSize: 16,
              background: (state.running || !canAdd) ? "#9ca3af" : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
              cursor: (state.running) ? "not-allowed" : "pointer",
            }}>+ 2:00</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {list.length === 0 ? (
          <div style={{ opacity: 0.6 }}>Ei jäähyjä</div>
        ) : (
          list.map((secs, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>#{i + 1} – {formatMMSS(secs)}</span>
              <button
                disabled={state.running}
                onClick={() => onRemove(i)}
                style={{
                  fontSize: 16,
                  background: (state.running) ? "#9ca3af" : "#3b82f6",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                  cursor: (state.running) ? "not-allowed" : "pointer",
                }}>Poista</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DisplayView({ state, soundUrl, volume }) {
  const [primed, setPrimed] = useState(false);
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 24,
      background: "black",
      color: "white",
      textAlign: "center",
      position: "relative",
    }}>
      
      <div style={{ fontSize: 160, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {formatMMSS((state.timeout && state.timeout.active) ? state.timeout.seconds : state.seconds)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 12 }}>
        <div>
            {((state.timeout && state.timeout.active && state.timeout.team === "home") ||
             (!state.timeoutsUsed.home && !(state.timeout && state.timeout.active) && (state.seconds > 0 || state.period > 1))) ? (
              <div style={{
                marginTop: 8,
                padding: "6px 12px",
                borderRadius: 999,
                background: "#ef4444",
                color: "#111827",
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: 1,
              }}>
              </div>
            ) : null}
          <br></br>
          <ScorePill label={(state.homeName || "KOTI").toUpperCase()} value={state.home} />
          <br></br>
          <PenaltyChips title="KOTI" list={state.penalties.home} />
        </div>
        <div style={{ fontSize: 40, letterSpacing: 1, paddingBottom: "80px" }}>ERÄ {state.period ?? 1}</div>
        <div>

            {((state.timeout && state.timeout.active && state.timeout.team === "guest") ||
             (!state.timeoutsUsed.guest && !(state.timeout && state.timeout.active) && (state.seconds > 0 || state.period > 1))) ? (
              <div style={{
                marginTop: 8,
                padding: "6px 12px",
                borderRadius: 999,
                background: "#ef4444",
                color: "#111827",
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: 1,
              }}>
              </div>
            ) : null}

          <br></br>
          <ScorePill label={(state.guestName || "VIERAS").toUpperCase()} value={state.guest} />
          <br></br>
          <PenaltyChips title="VIERAS" list={state.penalties.guest} />
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {list.length === 0 ? (
        <span style={{ 
          border: "1px solid #fff",
            borderRadius: 10,
            padding: "4px 10px",
            fontVariantNumeric: "tabular-nums",
            fontSize: 40,
            opacity:0
           }}>x</span>
      ) : (
        list.map((secs, i) => (
          <span key={i} style={{
            border: "1px solid #fff",
            borderRadius: 10,
            padding: "4px 10px",
            fontVariantNumeric: "tabular-nums",
            color: "#ef4444",
            fontSize: 40,
          }}>{formatMMSS(secs)}</span>
        ))
      )}
    </div>
  );
}

function ScorePill({ label, value }) {
  return (
    <div style={{ border: "2px solid #fff", borderRadius: 16, padding: "12px 20px", minWidth: 160 }}>
      <div style={{ marginBottom: 4, fontSize: 30 }}>{label}</div>
      <div style={{ fontSize: 80, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
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
  const [state, dispatch] = useReducer(reducer, initialState);
  const [soundOn, setSoundOn] = useState(true); // per-tab toggle
  const [soundUrl, setSoundUrl] = useState("buzzer.mp3"); // place file in public/
  const [volume, setVolume] = useState(1);

  // ticking & cross-tab sync
  useGameLoop(state, dispatch);
  useCrossTabSync(state, dispatch);

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
