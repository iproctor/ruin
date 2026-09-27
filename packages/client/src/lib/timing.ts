import type { GameEvent, Power } from '@ruin/engine';

export interface TimingOptions {
  myPowers: Power[];
  cinematics: boolean;
  /** Multiplier from the animation-speed setting (1 = normal). */
  speed: number;
}

function isMine(ev: GameEvent, myPowers: Power[]) {
  return 'power' in ev && myPowers.includes((ev as { power: Power }).power);
}

/**
 * How long the event queue waits after applying `ev` before the next one.
 * This is the single pacing table for every animation in the game.
 */
export function eventDuration(ev: GameEvent, opts: TimingOptions): number {
  const cine = opts.cinematics;
  const mine = isMine(ev, opts.myPowers);
  const base = (() => {
    switch (ev.type) {
      case 'phase_start': return 1900;
      case 'world_card_drawn': return cine ? 2600 : 600;
      case 'token_placed': return 260;
      case 'token_removed': return 200;
      case 'power_draw': return 120;
      case 'summon_figure': return mine ? 650 : 1000;
      case 'play_card': return cine && !mine ? 2300 : 1000;
      case 'card_effect': return 900;
      case 'summoning_pass': return 350;
      case 'battle_region_start': return cine ? 1900 : 1000;
      case 'battle_roll': return cine ? 1500 + ev.dice.length * 110 : 1400;
      case 'battle_kill': return cine ? 950 : 500;
      case 'peasant_claimed': return cine ? 700 : 600;
      case 'rapture_control': return 1100;
      case 'war_frenzy_partial': return 600;
      case 'heartrippers_corruption': return 700;
      case 'domination_result': return ev.conquered ? 1900 : 0;
      case 'domination_failed': return 0;
      case 'corruption_placement': return 800;
      case 'deaths_perfume': return 800;
      case 'vile_consumption': return 900;
      case 'war_cry_block': return 600;
      case 'ruination': return cine ? 3800 : 2400;
      case 'ruination_scoring': return 1600;
      case 'provender_score': return 900;
      case 'dial_counter': return 350;
      case 'dial_advance': return 1400;
      case 'dial_vp': return 700;
      case 'dial_victory': return 1500;
      case 'hero_removal': return 1100;
      case 'hero_forced_removal': return 900;
      case 'harvest_kill': return 900;
      case 'world_card_effect': return 900;
      case 'upgrade_taken': return 1600;
      case 'game_over': return 2400;
      default: return 0;
    }
  })();
  return Math.round(base * opts.speed);
}
