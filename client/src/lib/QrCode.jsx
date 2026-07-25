import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Renders a QR code (as an <img> data URL) for the given value. Dark modules on
// a cream field for high-contrast scanning against the green lobby panel.
export default function QrCode({ value, size = 200, className }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      margin: 1,
      width: size * 2,                 // 2x for a crisp image when scaled on the TV
      errorCorrectionLevel: 'M',
      color: { dark: '#0b241a', light: '#fff5e1' }
    })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [value, size]);
  if (!src) return null;
  return <img className={className} src={src} alt="Scan to join" width={size} height={size} draggable={false} />;
}
