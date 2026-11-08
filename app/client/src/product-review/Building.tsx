import { useId } from 'react';

export type BuildingKind = 'house' | 'apartment' | 'office' | 'studio' | 'school';
export interface BuildingProps { id: string; label: string; kind?: BuildingKind; className?: string }
export function buildingKind(id: string, label: string): BuildingKind {
  if (/офіс|робот/iu.test(label)) return 'office';
  if (/майстер|студі/iu.test(label)) return 'studio';
  if (/школ|садоч/iu.test(label)) return 'school';
  if (/батьк|бабус|дідус/iu.test(label)) return 'apartment';
  if (/дім|дома/iu.test(label)) return 'house';
  const hash = [...id].reduce((a, ch) => (a * 31 + ch.codePointAt(0)!) >>> 0, 7);
  return (['house', 'apartment', 'office', 'studio', 'school'] as const)[hash % 5];
}

/** Neutral architecture identifies saved places. Window colour is not a power sensor. */
export function Building({ id, label, kind, className = '' }: BuildingProps) {
  const unique = useId().replace(/[^a-zA-Z0-9_-]/g, '-'), shape = kind || buildingKind(id, label);
  const roofId = `pr-roof-${unique}`, titleId = `pr-house-title-${unique}`;
  const tall = shape === 'apartment' || shape === 'office', studio = shape === 'studio', school = shape === 'school';
  const top = tall ? 27 : studio ? 65 : school ? 53 : 48;
  const roof = tall || studio || school;
  const columns = shape === 'office' ? 4 : tall ? 3 : school ? 4 : 2;
  const floors = tall ? 4 : studio ? 1 : school ? 2 : 2;
  return <svg className={`pr-building ${className}`} data-kind={shape} viewBox="0 0 160 136" role="img" aria-labelledby={titleId} focusable="false">
    <title id={titleId}>{`Будівля адреси «${label}»`}</title>
    <defs><linearGradient id={roofId} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--pr-building-roof, #dce5e0)" /><stop offset="1" stopColor="var(--pr-building-roof-shade, #a9bdb6)" /></linearGradient></defs>
    <ellipse className="pr-building-shadow" cx="82" cy="120" rx="54" ry="9" fill="var(--pr-building-shadow, #000000)" opacity=".1" />
    <path d="M22 112 76 128 139 107 85 91Z" className="pr-building-ground" fill="var(--pr-building-ground, #dfe7e2)" stroke="var(--pr-building-line, #b4c8be)" strokeWidth=".5" />
    <g className="pr-building-object">
      <path d={`M78 ${top + 11} 127 ${top - 4} 127 105 78 121Z`} fill="var(--pr-building-side, #8da9a1)" stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" />
      <path d={`M35 ${top - 4} 78 ${top + 11} 78 121 35 105Z`} fill="var(--pr-building-front, #c2d6cd)" stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" />
      {roof ? <><path d={`M35 ${top - 4} 84 ${top - 19} 127 ${top - 4} 78 ${top + 11}Z`} fill={`url(#${roofId})`} stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" />
        {shape === 'office' && <path d={`M87 ${top - 17} 118 ${top - 7} 88 ${top + 2} 57 ${top - 8}Z`} fill="var(--pr-building-window, #9eb7ae)" opacity=".45" />}
        {studio && <path d={`M69 ${top - 14} 87 ${top - 19} 105 ${top - 13} 87 ${top - 7}Z`} fill="var(--pr-building-window, #9eb7ae)" />}</>
        : <><path d={`M28 ${top - 3} 57 ${top - 25} 86 ${top + 13} 78 ${top + 15} 35 ${top}Z`} fill={`url(#${roofId})`} stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" />
          <path d={`M57 ${top - 25} 106 ${top - 40} 134 ${top - 3} 86 ${top + 13}Z`} fill="var(--pr-building-roof-shade, #a9bdb6)" stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" /></>}
      {Array.from({ length: floors }, (_, row) => Array.from({ length: columns }, (_, col) => {
        const width = shape === 'office' ? 7 : 8, x = 41 + col * (shape === 'office' ? 8 : 11);
        const y = top + 12 + row * (tall ? 16 : 18) + col * 3.8;
        return <path key={`front-${row}-${col}`} d={`M${x} ${y} ${x + width} ${y + width * .35} ${x + width} ${y + 9 + width * .35} ${x} ${y + 9}Z`} fill="var(--pr-building-window, #718f84)" opacity=".65" />;
      }))}
      {Array.from({ length: floors }, (_, row) => Array.from({ length: 3 }, (_, col) => {
        const x = 86 + col * 12, y = top + 20 + row * (tall ? 16 : 18) - col * 4;
        return <path key={`side-${row}-${col}`} d={`M${x} ${y} ${x + 7} ${y - 2.5} ${x + 7} ${y + 6.5} ${x} ${y + 9}Z`} fill="var(--pr-building-window, #718f84)" opacity=".5" />;
      }))}
      <path d="M52 94 63 98 63 115 52 111Z" fill="var(--pr-building-door, #68877b)" opacity=".8" />
      {school && <path d="M77 49 81 48 81 79 77 80Z" fill="var(--pr-building-line, #9bb4a9)" />}
      <path d={`M35 ${top - 4} 35 105 78 121 127 105 127 ${top - 4}`} className="pr-building-outline" fill="none" stroke="var(--pr-building-line, #9bb4a9)" strokeWidth=".7" />
    </g>
  </svg>;
}
