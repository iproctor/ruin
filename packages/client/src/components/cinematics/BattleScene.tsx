import { useEffect, useMemo, useRef } from 'react';
import type { FollowerClass, FollowerInstance, Power, RegionId } from '@ruin/engine';
import { FOLLOWERS, REGIONS } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../../lib/display.js';
import { followerArt, regionArt, tokenArt } from '../../lib/art.js';
import { PowerSigil } from '../PowerSigil.js';
import { useFx } from '../fx/FxProvider.js';
import { useSound } from '../../contexts/SoundContext.js';
import Die3D from './Die3D.js';

export interface BattleRollView {
  id: number;
  power: Power;
  dice: number[];
  hits: number;
  kind: 'normal' | 'war_frenzy' | 'undying_fury';
}

export interface BattleView {
  key: number;
  regionId: RegionId;
  roster: FollowerInstance[];
  rolls: BattleRollView[];
  kills: Record<string, Power>;          // followerId → killer
  enthralled: Record<string, Power>;     // followerId → new controller
  wounded: Record<string, number>;       // War Frenzy partial hits
  peasants: Array<{ power: Power; id: number }>;
  awaitingPower: Power | null;           // someone must assign hits
}

const CLASS_ORDER: Record<FollowerClass, number> = { incarnation: 0, warrior: 1, cultist: 2 };
const KIND_LABEL: Record<BattleRollView['kind'], string | null> = {
  normal: null,
  war_frenzy: 'War Frenzy',
  undying_fury: 'Bloody Rebirth',
};

function controller(f: FollowerInstance): Power {
  return f.controlledBy ?? f.power;
}

export function FigureToken({ f, size, killed, enthralledBy, wounded, anchor }: {
  f: FollowerInstance;
  size: number;
  killed?: boolean;
  enthralledBy?: Power;
  wounded?: number;
  anchor?: string;
}) {
  const art = followerArt(f.power, f.class);
  const ring = POWER_COLORS[f.power];
  const ctrl = enthralledBy ?? (f.controlledBy ?? undefined);
  const name = FOLLOWERS[f.power][f.class].name;
  return (
    <div
      className={`bs-fig bs-fig-${f.class} ${killed ? 'is-killed' : ''} ${ctrl ? 'is-enthralled' : ''} ${f.protected ? 'is-shielded' : ''}`}
      style={{ width: size, height: size, ['--ring' as string]: ring, ['--ctrl' as string]: ctrl ? POWER_COLORS[ctrl] : ring }}
      data-anchor={anchor}
      title={name}
    >
      <div className="bs-fig-art" style={art ? { backgroundImage: `url(${art})` } : undefined}>
        {!art && <span style={{ color: ring }}><PowerSigil power={f.power} size={size * 0.6} /></span>}
      </div>
      {killed && <div className="bs-fig-slash" />}
      {killed && <div className="bs-fig-skull">☠</div>}
      {!!wounded && !killed && <div className="bs-fig-wound">{wounded}</div>}
    </div>
  );
}

export default function BattleScene({ view, awaitingMe }: { view: BattleView; awaitingMe: boolean }) {
  const fx = useFx();
  const sound = useSound();
  const region = REGIONS[view.regionId];
  const art = regionArt(view.regionId);

  // Lanes: every power with figures in the fight, attackers first.
  const lanes = useMemo(() => {
    const byPower = new Map<Power, FollowerInstance[]>();
    for (const f of view.roster) {
      const p = controller(f);
      if (!byPower.has(p)) byPower.set(p, []);
      byPower.get(p)!.push(f);
    }
    for (const r of view.rolls) if (!byPower.has(r.power)) byPower.set(r.power, []);
    return [...byPower.entries()].map(([power, figs]) => ({
      power,
      figs: [...figs].sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class]),
    }));
  }, [view.roster, view.rolls]);

  const lastRoll = view.rolls[view.rolls.length - 1];
  const killedSeen = useRef(new Set<string>());
  const peasantsSeen = useRef(new Set<number>());

  // Kill feedback: particles + sound on the token itself.
  useEffect(() => {
    for (const id of Object.keys(view.kills)) {
      if (killedSeen.current.has(id)) continue;
      killedSeen.current.add(id);
      sound.kill();
      requestAnimationFrame(() => {
        fx.burst(`bfig-${id}`, 'kill', view.kills[id], 0.9);
        fx.shake(5, 380);
      });
    }
  }, [view.kills, fx, sound]);

  useEffect(() => {
    for (const p of view.peasants) {
      if (peasantsSeen.current.has(p.id)) continue;
      peasantsSeen.current.add(p.id);
      sound.hit();
      requestAnimationFrame(() => fx.burst(`blane-${p.power}`, 'gold', null, 0.7));
    }
  }, [view.peasants, fx, sound]);

  const figSize = lanes.length > 3 ? 46 : 54;

  return (
    <div className="bs" key={view.key}>
      <div className="bs-backdrop" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <div className="bs-vignette" />
      <div className="bs-header">
        <div className="bs-swords">⚔</div>
        <div className="bs-title">Battle for {region.name}</div>
        <div className="bs-sub">{lanes.map((l) => POWER_LABELS[l.power]).join(' · ')}</div>
      </div>

      <div className="bs-lanes">
        {lanes.map(({ power, figs }) => {
          const rolls = view.rolls.filter((r) => r.power === power);
          const roll = rolls[rolls.length - 1];
          const active = lastRoll?.power === power;
          const color = POWER_COLORS[power];
          const totalHits = rolls.reduce((a, r) => a + r.hits, 0);
          const peasantCount = view.peasants.filter((p) => p.power === power).length;
          return (
            <div key={power} className={`bs-lane ${active ? 'is-active' : ''}`} style={{ ['--accent' as string]: color }} data-anchor={`blane-${power}`}>
              <div className="bs-lane-head">
                <span className="bs-lane-sigil" style={{ color }}><PowerSigil power={power} size={30} /></span>
                <span className="bs-lane-name">{POWER_LABELS[power]}</span>
              </div>
              <div className="bs-lane-figs">
                {figs.length === 0 && <span className="bs-lane-empty">no figures</span>}
                {figs.map((f) => (
                  <FigureToken
                    key={f.id}
                    f={f}
                    size={f.class === 'incarnation' ? figSize * 1.25 : f.class === 'warrior' ? figSize : figSize * 0.85}
                    killed={!!view.kills[f.id]}
                    enthralledBy={view.enthralled[f.id]}
                    wounded={view.wounded[f.id]}
                    anchor={`bfig-${f.id}`}
                  />
                ))}
                {peasantCount > 0 && (
                  <div className="bs-peasants" title="Peasants claimed">
                    {tokenArt('peasant') ? <img src={tokenArt('peasant')} alt="" /> : '⚒'} ×{peasantCount}
                  </div>
                )}
              </div>
              <div className="bs-tray">
                {roll ? (
                  <>
                    {KIND_LABEL[roll.kind] && <div className="bs-roll-kind">{KIND_LABEL[roll.kind]}</div>}
                    <div className="bs-dice" key={roll.id}>
                      {roll.dice.map((d, i) => (
                        <Die3D
                          key={`${roll.id}-${i}`}
                          value={d}
                          size={roll.dice.length > 6 ? 30 : 38}
                          delay={i * 90}
                          duration={950}
                          tint={color}
                          onLand={(v) => {
                            sound.diceLand(v >= 4);
                            if (v === 6) sound.diceExplode();
                          }}
                        />
                      ))}
                    </div>
                    <div className={`bs-hits ${roll.hits > 0 ? 'has-hits' : ''}`} key={`h${roll.id}`}>
                      {roll.hits > 0 ? `${roll.hits} ${roll.hits === 1 ? 'hit' : 'hits'}` : 'no hits'}
                      {rolls.length > 1 && <span className="bs-hits-total"> · {totalHits} total</span>}
                    </div>
                  </>
                ) : (
                  <div className="bs-tray-idle">{figs.some((f) => f.class !== 'cultist') ? 'readying…' : ''}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {view.awaitingPower && (
        <div className="bs-await" style={{ ['--accent' as string]: POWER_COLORS[view.awaitingPower] }}>
          {awaitingMe ? 'Choose your victims →' : `${POWER_LABELS[view.awaitingPower]} chooses victims…`}
        </div>
      )}
    </div>
  );
}
