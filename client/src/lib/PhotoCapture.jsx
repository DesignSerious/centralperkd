import React, { useEffect, useRef, useState } from 'react';
import { getSocket } from './socket';

// Full-screen modal that opens the phone's front camera, lets the player
// frame a selfie inside a circular crop overlay, captures a 256x256 JPEG
// (mirrored to match the live preview), and returns the data URL via
// onConfirm. onCancel closes without producing an image.
//
// `getUserMedia` requires HTTPS or localhost — on plain HTTP from a LAN IP
// the browser silently rejects, which we surface as a friendly fallback so
// the user can still pick a figurine from the regular grid.
//
// Also offers a "Turn into figurine" path that posts the photo to the
// server's /api/generate-piece-from-photo endpoint and shows the resulting
// AI piece in the same modal. If the player accepts the AI figurine, the
// onConfirm value is the /ai-pieces/{hex}.png URL instead of the raw photo
// data URL.
const CAPTURE_SIZE = 256;
const JPEG_QUALITY = 0.78;

export default function PhotoCapture({ onConfirm, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState(null);
  const [aiState, setAiState] = useState('idle'); // 'idle' | 'loading' | 'preview'
  const [aiUrl, setAiUrl] = useState(null);
  const [aiRemaining, setAiRemaining] = useState(null);
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('Camera not supported on this device.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        setError('Camera unavailable. Pick a figurine instead.');
      }
    }
    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    const ctx = canvas.getContext('2d');
    // Mirror the canvas so the captured JPEG matches what the player saw in
    // the live preview (which the browser auto-mirrors for selfie cameras).
    ctx.translate(CAPTURE_SIZE, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    setDataUrl(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
  }

  function retake() {
    setDataUrl(null);
    setAiState('idle');
    setAiUrl(null);
    setAiError('');
  }

  function confirm() {
    if (!dataUrl) return;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    onConfirm(dataUrl);
  }

  function confirmAi() {
    if (!aiUrl) return;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    onConfirm(aiUrl);
  }

  function turnIntoFigurine() {
    if (!dataUrl) return;
    setAiError('');
    setAiState('loading');
    fetch('/api/generate-piece-from-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socketId: getSocket().id || '', photoDataUrl: dataUrl })
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, body: j })))
      .then((out) => {
        if (!out.ok || !out.body || !out.body.ok) {
          const msg = (out.body && out.body.error) || 'Generation failed. Try again.';
          setAiError(msg);
          if (out.body && typeof out.body.remaining === 'number') setAiRemaining(out.body.remaining);
          setAiState('idle');
          return;
        }
        setAiUrl(out.body.url);
        if (typeof out.body.remaining === 'number') setAiRemaining(out.body.remaining);
        setAiState('preview');
      })
      .catch((e) => {
        setAiError('Network error: ' + e.message);
        setAiState('idle');
      });
  }

  return (
    <div className="photo-capture-backdrop" role="dialog" aria-modal="true">
      <div className="photo-capture-modal">
        <div className="photo-capture-title">Take a Photo</div>
        <p className="photo-capture-caption">Snap a selfie and we'll turn it into your figurine.</p>

        {error && (
          <>
            <div className="photo-capture-error">{error}</div>
            <div className="photo-capture-actions">
              <button type="button" className="lp-btn" onClick={onCancel}>Close</button>
            </div>
          </>
        )}

        {!error && (
          <>
            <div className="photo-capture-stage">
              {aiState === 'preview' && aiUrl
                ? <img className="photo-capture-ai-preview" src={aiUrl} alt="Generated figurine" />
                : aiState === 'loading'
                  ? (
                      <div className="photo-capture-loading">
                        <div className="lp-spinner spinner" />
                        <div className="photo-capture-loading-text">Turning your photo into a figurine…</div>
                      </div>
                    )
                  : dataUrl
                    ? <img className="photo-capture-frame" src={dataUrl} alt="Captured photo" />
                    : <video ref={videoRef} className="photo-capture-frame" autoPlay playsInline muted />}
            </div>

            {aiError && <div className="photo-capture-error">{aiError}</div>}
            {aiRemaining != null && aiState !== 'loading' && (
              <div className="photo-capture-remaining">
                {aiRemaining > 0
                  ? aiRemaining + ' AI generation' + (aiRemaining === 1 ? '' : 's') + ' left this game'
                  : 'No AI generations left this game.'}
              </div>
            )}

            <div className="photo-capture-actions">
              {aiState === 'preview' && aiUrl ? (
                <>
                  <button type="button" className="lp-btn lp-btn--ghost" onClick={retake}>Retake photo</button>
                  <button
                    type="button"
                    className="lp-btn lp-btn--ghost"
                    onClick={turnIntoFigurine}
                    disabled={aiRemaining === 0}
                  >
                    Regenerate
                  </button>
                  <button type="button" className="lp-btn" onClick={confirmAi}>Use figurine</button>
                </>
              ) : aiState === 'loading' ? (
                <button type="button" className="lp-btn lp-btn--ghost" disabled>Generating…</button>
              ) : dataUrl ? (
                <>
                  <button type="button" className="lp-btn lp-btn--ghost" onClick={retake}>Retake</button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={turnIntoFigurine}
                    disabled={aiRemaining === 0}
                  >
                    Make figurine
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="lp-btn lp-btn--ghost" onClick={onCancel}>Cancel</button>
                  <button type="button" className="lp-btn" onClick={capture}>Capture</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
