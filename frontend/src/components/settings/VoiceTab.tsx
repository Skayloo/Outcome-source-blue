/**
 * Voice & Audio settings tab — input/output devices, volumes, sensitivity (with a
 * live mic level meter), stream quality, video device + camera preview, and audio
 * processing toggles. Ported from the deprecated Tauri client's VoiceAudioTab.
 */
import { useEffect, useRef, useState } from "react";
import { Section, Row, Select, Slider, ToggleRow, type Opt } from "@components/settings/controls";
import { prefetchDeepFilter } from "@lib/noise-suppression-dfn";
import { vadThreshold } from "@lib/audioPipeline";
import { loadPref, savePref } from "@components/settings/helpers";
import { t } from "@lib/i18n";
import {
  switchInputDevice,
  switchOutputDevice,
  setInputVolume,
  setOutputVolume,
  setVoiceSensitivity,
  activeNoiseEngine,
  reapplyAudioProcessing,
} from "@lib/livekitSession";

interface DeviceLists {
  inputs: Opt[];
  outputs: Opt[];
  videos: Opt[];
}

// Built at render so labels follow the active locale.
function qualityOptions(): Opt[] {
  return [
    { value: "low", label: t("settings.qualityLow") },
    { value: "medium", label: t("settings.qualityMedium") },
    { value: "high", label: t("settings.qualityHigh") },
    { value: "source", label: t("settings.qualitySource") },
  ];
}

export function VoiceTab() {
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [], videos: [] });
  // Mirrors the enhanced-suppressor preference so the two rows it overrides re-render the
  // moment it moves, instead of lying until the panel is reopened.
  const [enhanced, setEnhanced] = useState<boolean>(() => loadPref<boolean>("enhancedNoiseSuppression", true));
  const [engine, setEngine] = useState<string>(() => loadPref<string>("nsEngine", "deepfilter"));
  const strengthTimer = useRef<number | null>(null);
  // Polled rather than pushed: it changes at most once per call, and a store for one string
  // that only the settings screen reads is not worth the wiring.
  const [active, setActive] = useState<string | null>(() => activeNoiseEngine());
  useEffect(() => {
    const id = window.setInterval(() => setActive(activeNoiseEngine()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Device enumeration ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let unlockStream: MediaStream | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    async function enumerate(): Promise<void> {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const inputs: Opt[] = [{ value: "", label: t("settings.deviceDefault") }];
        const outputs: Opt[] = [{ value: "", label: t("settings.deviceDefault") }];
        const videos: Opt[] = [{ value: "", label: t("settings.deviceDefault") }];
        for (const d of list) {
          if (d.kind === "audioinput") {
            inputs.push({ value: d.deviceId, label: d.label || t("settings.deviceMicrophone", { id: d.deviceId.slice(0, 8) }) });
          } else if (d.kind === "audiooutput") {
            outputs.push({ value: d.deviceId, label: d.label || t("settings.deviceSpeaker", { id: d.deviceId.slice(0, 8) }) });
          } else if (d.kind === "videoinput") {
            videos.push({ value: d.deviceId, label: d.label || t("settings.deviceCamera", { id: d.deviceId.slice(0, 8) }) });
          }
        }
        setDevices({ inputs, outputs, videos });
      } catch {
        /* enumeration unavailable — keep defaults */
      }
    }

    const onDeviceChange = (): void => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => { void enumerate(); }, 300);
    };

    void (async () => {
      try {
        // Unlock device labels by holding an audio stream once.
        unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        /* mic denied — labels may be blank, still enumerate */
      }
      if (cancelled) {
        if (unlockStream !== null) for (const t of unlockStream.getTracks()) t.stop();
        unlockStream = null;
        return;
      }
      await enumerate();
      navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    })();

    return () => {
      cancelled = true;
      if (debounce !== null) clearTimeout(debounce);
      navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      if (unlockStream !== null) {
        for (const t of unlockStream.getTracks()) t.stop();
        unlockStream = null;
      }
    };
  }, []);

  return (
    <div className="settings-pane active">
      <Section title={t("settings.inputDevice")} />
      <Row label={t("settings.microphone")} desc={t("settings.microphoneDesc")}>
        <Select
          k="audioInputDevice"
          def=""
          options={devices.inputs}
          onChange={(v) => { void switchInputDevice(v); }}
        />
      </Row>
      <Row label={t("settings.inputVolume")} desc={t("settings.inputVolumeDesc")}>
        <Slider
          k="inputVolume"
          def={100}
          min={0}
          max={200}
          step={5}
          format={(n) => `${n}%`}
          onChange={(v) => setInputVolume(v)}
        />
      </Row>

      <SensitivityMeter />
      <MicTest />

      <Section title={t("settings.outputDevice")} />
      <Row label={t("settings.speaker")} desc={t("settings.speakerDesc")}>
        <Select
          k="audioOutputDevice"
          def=""
          options={devices.outputs}
          onChange={(v) => { void switchOutputDevice(v); }}
        />
      </Row>
      <Row label={t("settings.outputVolume")} desc={t("settings.outputVolumeDesc")}>
        <Slider
          k="outputVolume"
          def={100}
          min={0}
          max={200}
          step={5}
          format={(n) => `${n}%`}
          onChange={(v) => setOutputVolume(v)}
        />
      </Row>

      <Section title={t("settings.video")} />
      <Row
        label={t("settings.streamQuality")}
        desc={t("settings.streamQualityDesc")}
      >
        <Select
          k="streamQuality"
          def="medium"
          options={qualityOptions()}
          // consumed at next voice join
          onChange={(v) => savePref("streamQuality", v)}
        />
      </Row>
      <CameraPreview videos={devices.videos} />

      <Section title={t("settings.audioProcessing")} />
      <ToggleRow
        label={t("settings.echoCancellation")}
        desc={t("settings.echoCancellationDesc")}
        k="echoCancellation"
        def={true}
        onChange={() => { void reapplyAudioProcessing(); }}
      />
      {/* Both of these are forced off while the enhanced suppressor runs, so they are shown
          off and locked. A switch that reads "on" while the code ignores it is how someone
          ends up believing their noise is handled when it is not. */}
      <ToggleRow
        label={t("settings.noiseSuppression")}
        desc={enhanced ? t("settings.overriddenByEnhanced") : t("settings.noiseSuppressionDesc")}
        k="noiseSuppression"
        def={true}
        disabled={enhanced}
        onChange={() => { void reapplyAudioProcessing(); }}
      />
      <ToggleRow
        label={t("settings.autoGainControl")}
        desc={enhanced ? t("settings.agcOverriddenByEnhanced") : t("settings.autoGainControlDesc")}
        k="autoGainControl"
        def={true}
        disabled={enhanced}
        onChange={() => { void reapplyAudioProcessing(); }}
      />
      <ToggleRow
        label={t("settings.enhancedNoiseSuppression")}
        desc={t("settings.enhancedNoiseSuppressionDesc")}
        k="enhancedNoiseSuppression"
        // On by default: the browser's own suppression leaves steady broadband noise — a fan,
        // a hiss — which is what actually ruins a call.
        def={true}
        onChange={(v) => { setEnhanced(v); void reapplyAudioProcessing(); }}
      />
      <Row label={t("settings.nsEngine")} desc={t("settings.nsEngineDesc")}>
        <Select
          k="nsEngine"
          def="deepfilter"
          options={[
            { value: "rnnoise", label: t("settings.nsEngineRnnoise") },
            { value: "deepfilter", label: t("settings.nsEngineDeepFilter") },
          ]}
          // Applied to the call you are in, not the next one — the whole point of switching
          // is that someone can hear the fan RIGHT NOW.
          onChange={(v) => {
            savePref("nsEngine", v);
            setEngine(v);
            if (v === "deepfilter") void prefetchDeepFilter();
            void reapplyAudioProcessing();
          }}
        />
      </Row>
      {/* What is actually running, which is not always what is selected: on the very first
          call of a session the model may still be downloading and RNNoise holds the track.
          Asking someone to open a console to find this out is not an answer. */}
      {enhanced && active !== null && (
        <Row label={t("settings.nsActive")}>
          <span className={"ns-active" + (active.startsWith("deepfilter") ? " strong" : "")}>
            {active.startsWith("deepfilter")
              ? t("settings.nsActiveStrong")
              : t("settings.nsActiveLight")}
          </span>
        </Row>
      )}
      {enhanced && engine === "deepfilter" && (
        <Row label={t("settings.nsStrength")} desc={t("settings.nsStrengthDesc")}>
          <Slider
            k="nsStrength"
            def={20}
            // Decibels, not percent: the number goes straight to the model's attenuation
            // limit. The old range said 25–100% and read like a quality dial, so 40 looked
            // modest — it is 40 dB, deep into where the model takes speech with the noise.
            // 40 dB is the ceiling now, and nothing here can reach the setting that ate words.
            min={0}
            max={40}
            step={2}
            format={(n) => `${n} dB`}
            // Every change rebuilds the processor, so settle first: dragging across the
            // range would otherwise tear down and rebuild it a dozen times mid-call.
            onChange={() => {
              if (strengthTimer.current !== null) window.clearTimeout(strengthTimer.current);
              strengthTimer.current = window.setTimeout(() => { void reapplyAudioProcessing(); }, 400);
            }}
          />
        </Row>
      )}
    </div>
  );
}

/**
 * Input sensitivity slider plus a live mic level meter. Opens a local
 * getUserMedia stream + AudioContext AnalyserNode and paints the level bar each
 * animation frame (green above the sensitivity threshold, dim below).
 */
function SensitivityMeter() {
  const levelRef = useRef<HTMLDivElement | null>(null);
  const thresholdRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest sensitivity readable inside the rAF loop without re-subscribing.
  // 98, not 95 and not 100. At 95 the gate shut at 0.005 RMS (about -46 dBFS), which is the
  // noise floor of a quiet room — it was closing on people mid-pause. At 100 it does not run at
  // all (see audioPipeline), so a noisy room transmits its floor for the whole call. 98 puts
  // the line at 0.002, roughly -54 dBFS: true silence still closes it, speech never will.
  const sensitivityRef = useRef<number>(loadPref<number>("voiceSensitivity", 98));

  useEffect(() => {
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf: number | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const savedDevice = loadPref<string>("audioInputDevice", "");
        const stm = await navigator.mediaDevices.getUserMedia({
          audio: savedDevice ? { deviceId: { exact: savedDevice } } : true,
          video: false,
        });
        if (cancelled) {
          for (const t of stm.getTracks()) t.stop();
          return;
        }
        stream = stm;
        const ctx = new AudioContext();
        audioCtx = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        ctx.createMediaStreamSource(stm).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = (): void => {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] ?? 0) / 255;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const visual = Math.min(Math.sqrt(rms) * 2, 1);
          const level = levelRef.current;
          if (level !== null) {
            level.style.width = `${visual * 100}%`;
            // The same function the gate uses. This was its own copy of the formula with a
            // different constant, so the meter drew the line half again as high as the gate
            // really opened: you could set the slider until the room sat below the line,
            // see it stay dim, and transmit it anyway.
            const threshold = vadThreshold(sensitivityRef.current);
            // green above threshold (voice detected) / dim below
            level.style.background = rms >= threshold ? "#43b581" : "#faa61a";
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        /* mic denied — meter stays empty */
      }
    })();

    return () => {
      cancelled = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (stream !== null) for (const t of stream.getTracks()) t.stop();
      if (audioCtx !== null) void audioCtx.close();
    };
  }, []);

  // Single Discord-style control: the live level fills the bar, and the draggable
  // handle sets the threshold. sensitivity 100 → handle at LEFT (easiest to pass),
  // 0 → RIGHT (hardest). One row, no separate static slider.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [sensitivity, setSensitivity] = useState<number>(sensitivityRef.current);
  const draggingRef = useRef(false);

  const applyFromClientX = (clientX: number): void => {
    const bar = barRef.current;
    if (bar === null) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const value = Math.round((1 - ratio) * 100); // left = 100, right = 0
    sensitivityRef.current = value;
    setSensitivity(value);
    savePref("voiceSensitivity", value);
    setVoiceSensitivity(value);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent): void => { if (draggingRef.current) applyFromClientX(e.clientX); };
    const onUp = (): void => { draggingRef.current = false; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  return (
    <div className="sensitivity-block">
      <Row label={t("settings.inputSensitivity")} desc={t("settings.inputSensitivityDesc")}>
        <span className="sensitivity-value">{sensitivity}</span>
      </Row>
      <div
        className="mic-meter-wrap"
        onPointerDown={(e) => { draggingRef.current = true; applyFromClientX(e.clientX); }}
      >
        <div className="mic-meter-bar" ref={barRef}>
          <div className="mic-meter-level" ref={levelRef} />
          <div
            className="mic-meter-threshold"
            ref={thresholdRef}
            style={{ left: `${100 - sensitivity}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Video device picker plus an on-demand camera preview. "Test camera" opens a
 * getUserMedia({ video }) stream into the <video> element; "Stop" ends the tracks.
 * The active stream is always torn down on unmount.
 */
function CameraPreview({ videos }: { videos: Opt[] }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [device, setDevice] = useState<string>(() => loadPref<string>("videoInputDevice", ""));
  const [active, setActive] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const stop = (): void => {
    if (streamRef.current !== null) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (videoRef.current !== null) videoRef.current.srcObject = null;
    setActive(false);
  };

  useEffect(() => {
    // Stop any active preview when unmounting.
    return () => {
      if (streamRef.current !== null) {
        for (const t of streamRef.current.getTracks()) t.stop();
        streamRef.current = null;
      }
    };
  }, []);

  const start = (): void => {
    stop();
    setError("");
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: device
            ? { deviceId: { exact: device }, width: { ideal: 320 }, height: { ideal: 180 } }
            : { width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current !== null) videoRef.current.srcObject = stream;
        setActive(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("settings.cameraUnavailable"));
        setActive(false);
      }
    })();
  };

  return (
    <>
      <Row label={t("settings.videoDevice")} desc={t("settings.videoDeviceDesc")}>
        <Select
          k="videoInputDevice"
          def=""
          value={device}
          options={videos}
          onChange={(v) => {
            setDevice(v);
            savePref("videoInputDevice", v);
            if (active) start();
          }}
        />
      </Row>
      <Row label={t("settings.cameraPreview")} desc={t("settings.cameraPreviewDesc")}>
        <button className="ac-btn" type="button" onClick={active ? stop : start}>
          {active ? t("settings.stop") : t("settings.testCamera")}
        </button>
      </Row>
      <div
        style={{
          marginBottom: 16,
          borderRadius: 8,
          overflow: "hidden",
          background: "#1e1f22",
          aspectRatio: "16 / 9",
          maxWidth: 320,
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
      {error !== "" && <div className="setting-desc">{error}</div>}
    </>
  );
}

/** Mic test: loop the selected microphone back to the speakers so you hear yourself. */
function MicTest() {
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const stop = (): void => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    setActive(false);
  };

  useEffect(() => () => stop(), []);

  const start = async (): Promise<void> => {
    setError("");
    try {
      const deviceId = loadPref<string>("audioInputDevice", "");
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      ctx.createMediaStreamSource(stream).connect(ctx.destination);
      await ctx.resume();
      setActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.micTestFailed"));
      stop();
    }
  };

  return (
    <Row label={t("settings.micTest")} desc={t("settings.micTestDesc")}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <button className={"ac-btn" + (active ? " on-red" : "")} onClick={() => { if (active) stop(); else void start(); }}>
          {active ? t("settings.micTestStop") : t("settings.micTestStart")}
        </button>
        {error !== "" && <div className="setting-desc" style={{ color: "var(--text-danger)" }}>{error}</div>}
      </div>
    </Row>
  );
}
