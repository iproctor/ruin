import { useEffect, useRef, useState } from 'react';

// Face layout: opposite faces sum to 7.
//   front=1  back=6  right=2  left=5  top=3  bottom=4
const FACE_ROT: Record<number, [number, number]> = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[26, 26], [50, 50], [74, 74]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};

const FACES: Array<{ n: number; t: string }> = [
  { n: 1, t: 'translateZ(var(--half))' },
  { n: 6, t: 'rotateY(180deg) translateZ(var(--half))' },
  { n: 2, t: 'rotateY(90deg) translateZ(var(--half))' },
  { n: 5, t: 'rotateY(-90deg) translateZ(var(--half))' },
  { n: 3, t: 'rotateX(90deg) translateZ(var(--half))' },
  { n: 4, t: 'rotateX(-90deg) translateZ(var(--half))' },
];

interface Die3DProps {
  value: number;
  size?: number;
  /** ms before the throw starts */
  delay?: number;
  duration?: number;
  tint: string;
  onLand?: (value: number) => void;
}

/** A bone die thrown in from the left with bounces, landing on `value`. */
export default function Die3D({ value, size = 44, delay = 0, duration = 1000, tint, onLand }: Die3DProps) {
  const cubeRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(false);
  const onLandRef = useRef(onLand);
  onLandRef.current = onLand;

  useEffect(() => {
    const cube = cubeRef.current;
    const wrap = wrapRef.current;
    if (!cube || !wrap) return;
    const [fx, fy] = FACE_ROT[value] ?? [0, 0];
    const spinsX = 2 + Math.floor(Math.random() * 2);
    const spinsY = 2 + Math.floor(Math.random() * 2);
    const endX = fx + 360 * spinsX;
    const endY = fy + 360 * spinsY;
    const zTwist = (Math.random() - 0.5) * 30;
    cube.animate(
      [
        { transform: `rotateX(${endX - 700}deg) rotateY(${endY - 540}deg) rotateZ(${zTwist - 90}deg)` },
        { transform: `rotateX(${endX - 180}deg) rotateY(${endY - 200}deg) rotateZ(${zTwist - 20}deg)`, offset: 0.55 },
        { transform: `rotateX(${endX - 30}deg) rotateY(${endY - 20}deg) rotateZ(${zTwist}deg)`, offset: 0.82 },
        { transform: `rotateX(${endX}deg) rotateY(${endY}deg) rotateZ(${zTwist}deg)` },
      ],
      { duration, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    );
    const fromX = -160 - Math.random() * 80;
    wrap.animate(
      [
        { transform: `translate(${fromX}px, -90px) scale(1.35)`, opacity: 0 },
        { transform: `translate(${fromX * 0.55}px, -40px) scale(1.2)`, opacity: 1, offset: 0.2 },
        { transform: `translate(${fromX * 0.2}px, 0px) scale(1)`, offset: 0.45 },
        { transform: `translate(${fromX * 0.08}px, -18px) scale(1.04)`, offset: 0.62 },
        { transform: `translate(0px, 0px) scale(1)`, offset: 0.8 },
        { transform: `translate(0px, -4px) scale(1)`, offset: 0.9 },
        { transform: `translate(0px, 0px) scale(1)` },
      ],
      { duration, delay, easing: 'ease-out', fill: 'both' },
    );
    const t = setTimeout(() => {
      setLanded(true);
      onLandRef.current?.(value);
    }, delay + duration * 0.95);
    return () => clearTimeout(t);
  }, [value, delay, duration]);

  const hit = value >= 4;
  const cls = `die ${landed ? 'is-landed' : ''} ${landed && hit ? 'is-hit' : ''} ${landed && !hit ? 'is-miss' : ''} ${landed && value === 6 ? 'is-six' : ''}`;
  return (
    <div ref={wrapRef} className={cls} style={{ width: size, height: size, ['--half' as string]: `${size / 2}px`, ['--tint' as string]: tint }}>
      <div className="die-shadow" />
      <div ref={cubeRef} className="die-cube">
        {FACES.map((f) => (
          <div key={f.n} className="die-face" style={{ transform: f.t }}>
            {PIPS[f.n]!.map(([x, y], i) => (
              <span key={i} className="die-pip" style={{ left: `${x}%`, top: `${y}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
