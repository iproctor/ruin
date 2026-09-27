// Art manifest for Ruin. Each entry becomes one generated painting.
//
//   node scripts/art/generate.mjs      — generate missing raw PNGs via `codex exec` (image_generation)
//   node scripts/art/process.mjs       — convert raw PNGs → web-sized .webp in src/assets/art
//
// Raw PNGs live in art-src/ (gitignored); processed webp is committed.

const STYLE =
  'Dark fantasy illustration for a premium board game. Grimdark painterly oil painting in the tradition of ' +
  'late-1980s/90s old-world fantasy wargame art: gothic renaissance setting, heavy impasto brushwork, dramatic ' +
  'chiaroscuro, smoke and embers, rich muted earth tones punctuated by intense ACCENT. ' +
  'Absolutely no text, letters, numbers, logos, borders, frames or watermarks. No eight-pointed stars or trademarked ' +
  'iconography. Dramatic and menacing but not gory: no visible wounds, no blood spray, no nudity.';

const ACCENT = {
  xarm: 'blood red and burnished brass',
  gormen: 'sickly bile green and rusted bronze',
  tenzen: 'arcane electric blue with warp-fire pink and violet',
  lasha: 'lurid purple and obscene magenta pink',
  world: 'cold steel blue and tarnished gold',
  neutral: 'ember orange and candle gold',
};

const ASPECT = {
  portrait: 'Portrait orientation, 2:3 aspect ratio (1024x1536).',
  square: 'Square 1:1 aspect ratio (1024x1024).',
  landscape: 'Landscape orientation, 3:2 aspect ratio (1536x1024).',
};

const e = (kind, id, accent, aspect, subject) => ({ kind, id, accent, aspect, subject });

const CARDS = [
  // ── Xarm ──
  e('cards', 'xarm_war_frenzy', 'xarm', 'portrait', 'A howling berserker cult of a war god: crimson-armoured warriors in brass skull helms charging through smoke and red mist, banners of flayed crimson cloth, a burning fortress behind.'),
  e('cards', 'xarm_war_cry', 'xarm', 'portrait', 'A towering crimson-armoured warlord roaring a war cry from a hilltop; a visible shockwave of sound scatters ash and crows while his warband raises axes behind him.'),
  e('cards', 'xarm_carnage_trap', 'xarm', 'portrait', 'A narrow mountain pass sealed by walls of brass spikes and heavy chains, fires burning in the gap, silhouettes of horned armoured warriors blocking every escape.'),
  e('cards', 'xarm_ritual_death', 'xarm', 'portrait', 'A brass altar on a smoking battlefield where a hooded war-priest raises a skull goblet to a crimson sky; piles of skulls, tallow candles, a glowing red ritual circle.'),
  e('cards', 'xarm_the_red_throne', 'xarm', 'portrait', 'An enormous brass throne atop a mountain of skulls beneath a blood-red sky, empty and radiating menace, rivers of molten brass flowing down the slopes.'),
  e('cards', 'xarm_bloody_rebirth', 'xarm', 'portrait', 'Fallen armoured warriors rising again from a crimson mist on a battlefield at dusk, glowing red eyes, their brass armour reforging itself in sparks.'),
  e('cards', 'xarm_call_to_war', 'xarm', 'portrait', 'A giant brass war horn sounded from a ruined watchtower, beacon fires igniting across dark hills, columns of crimson warbands marching toward the call.'),
  // ── Gormen ──
  e('cards', 'gormen_pestilent_aura', 'gormen', 'portrait', 'A bloated, grinning plague priest wreathed in a glowing green miasma, flies swirling around him like a halo, a village withering and rusting around him.'),
  e('cards', 'gormen_pestilent_touch', 'gormen', 'portrait', "A rotting gauntleted hand reaching toward a knight's polished breastplate; rust, mould and lichen spread across the metal where it touches."),
  e('cards', 'gormen_pandemic', 'gormen', 'portrait', 'A gothic city smothered in sickly green fog, plague carts in the streets, boarded doors, tolling bells, ravens circling the spires.'),
  e('cards', 'gormen_rain_of_bile', 'gormen', 'portrait', 'Sickly green rain pouring from boiling clouds over a muddy battlefield, horned one-eyed plague daemons revelling in the downpour, puddles glowing.'),
  e('cards', 'gormen_decay', 'gormen', 'portrait', 'A grand cathedral crumbling into moss, mould and giant mushrooms; fungal growth consuming stone saints, green light through broken windows.'),
  e('cards', 'gormen_vile_consumption', 'gormen', 'portrait', 'A gigantic bubbling cauldron in a rotten swamp, hooded plague cultists gleefully climbing its rim, green steam rising into a corrupted sky.'),
  e('cards', 'gormen_inevitable_rot', 'gormen', 'portrait', 'A great hourglass filled with glowing green sand set on a mossy tomb; behind it an entire army slowly collapsing into rust and dust.'),
  e('cards', 'gormen_deaths_perfume', 'gormen', 'portrait', 'A lush, sickly-green flower garden growing over a graveyard, spores drifting like pollen in shafts of light, a bloated hooded gardener tending pale lilies.'),
  // ── Tenzen ──
  e('cards', 'tenzen_changer_of_fate', 'tenzen', 'portrait', 'A many-armed feathered sorcerer weaving glowing blue threads of fate on a cosmic loom, the threads twisting and rewriting themselves.'),
  e('cards', 'tenzen_fate_shield', 'tenzen', 'portrait', 'A lone robed apprentice sorcerer protected by a spinning dome of blue and pink geometric sigils; arrows and blades shatter into butterflies against it.'),
  e('cards', 'tenzen_teleport', 'tenzen', 'portrait', 'An armoured warrior dissolving into a spiral of blue and pink flame on one cliff and reappearing across a chasm in a burst of kaleidoscopic light.'),
  e('cards', 'tenzen_the_meddling_of_rats', 'tenzen', 'portrait', "Robed ratmen scurrying through a candlelit scholar's library, stealing scrolls and papers, their eyes glowing blue in the dark."),
  e('cards', 'tenzen_stasis_web', 'tenzen', 'portrait', 'A shimmering web of crystalline blue energy trapping soldiers mid-stride, frozen in time inside fractal geometry.'),
  e('cards', 'tenzen_persistence_matrix', 'tenzen', 'portrait', 'An impossible Escher-like tower of floating crystal rings spinning around a glowing blue core, repeating into infinity.'),
  e('cards', 'tenzen_shimmer', 'tenzen', 'portrait', 'Hooded cultists flickering into mirror images and illusions inside a hall of mirrors, blue and pink reflections multiplying endlessly.'),
  e('cards', 'tenzen_siphon_power', 'tenzen', 'portrait', 'A sorcerer drawing streams of blue light out of a ring of kneeling rival mages into an ornate crystal staff.'),
  // ── Lasha ──
  e('cards', 'lasha_hollow_pact', 'lasha', 'portrait', 'Two masked nobles sealing a pact at a decadent masquerade, a kiss on a gloved hand, violet candles, a hollow painted smile behind one mask.'),
  e('cards', 'lasha_depraved_infiltration', 'lasha', 'portrait', 'A masked courtesan slipping through a palace corridor behind unsuspecting guards, trailing ribbons of glowing pink perfume smoke.'),
  e('cards', 'lasha_sweet_lies', 'lasha', 'portrait', "A beautiful androgynous courtier whispering into an old king's ear at court, violet silk, golden goblets, the whole court entranced."),
  e('cards', 'lasha_hidden_influence', 'lasha', 'portrait', 'Gloved hands moving carved game pieces shaped like nobles, heroes and peasants across a painted map of kingdoms, lit by purple candlelight.'),
  e('cards', 'lasha_narcotic_musk', 'lasha', 'portrait', 'A haze of glowing magenta perfume drifting through a soldiers’ camp; the soldiers lower their weapons, eyes glazed and enraptured.'),
  e('cards', 'lasha_ecstasy', 'lasha', 'portrait', 'A swirling violet dreamscape where warriors drop their swords and drift among silk and rose petals in a trance of bliss.'),
  e('cards', 'lasha_debauched_royalty', 'lasha', 'portrait', 'A decadent royal banquet in a gilded palace, crowned nobles in grotesque masks, overflowing goblets, purple drapery, rot beneath the opulence.'),
];

const UPGRADES = [
  e('upgrades', 'xarm_flood_of_ferocity', 'xarm', 'portrait', 'A crimson tide of charging armoured warriors pouring down a mountainside like a flood, banners and brass horns.'),
  e('upgrades', 'xarm_power_of_war', 'xarm', 'portrait', 'A brass crown impaled on a great war-axe planted in scorched earth, crackling with red lightning.'),
  e('upgrades', 'xarm_heartseekers_up', 'xarm', 'portrait', 'Zealot cultists in crimson hoods and brass masks sharpening curved daggers by firelight, eyes burning.'),
  e('upgrades', 'xarm_heartrippers_up', 'xarm', 'portrait', 'Horned crimson-skinned daemon warriors with long brass blades stepping through a burning gate.'),
  e('upgrades', 'xarm_heartgrinder_up', 'xarm', 'portrait', 'A colossal winged crimson daemon lord in brass armour with a great axe, towering over a burning castle.'),
  e('upgrades', 'gormen_provender_of_rot', 'gormen', 'portrait', 'A long feast table of rotting fruit and tarnished crowns, swarms of flies, a bloated lord at its head raising a goblet.'),
  e('upgrades', 'gormen_power_of_decay', 'gormen', 'portrait', 'A rusted iron crown overgrown with mushrooms and moss, dripping green ichor onto a mossy stone.'),
  e('upgrades', 'gormen_plaguecarriers_up', 'gormen', 'portrait', 'Hooded plague cultists pushing creaking carts through green fog, ringing handbells.'),
  e('upgrades', 'gormen_plaguebringers_up', 'gormen', 'portrait', 'One-eyed horned plague daemons with rusty blades marching in a buzzing swarm of flies.'),
  e('upgrades', 'gormen_plaguefather_up', 'gormen', 'portrait', 'An enormous jovial bloated plague lord with antlers seated in a swamp, surrounded by tiny mischievous imps.'),
  e('upgrades', 'tenzen_flood_of_magic', 'tenzen', 'portrait', 'A cascade of glowing blue scrolls and spellbooks pouring out of a swirling vortex in the sky.'),
  e('upgrades', 'tenzen_power_of_fate', 'tenzen', 'portrait', 'A crystal eye at the heart of a golden astrolabe, radiating rays of blue fate across a starfield.'),
  e('upgrades', 'tenzen_apprentices_up', 'tenzen', 'portrait', 'Young robed sorcerers carrying glowing blue stones across a floating crystal bridge.'),
  e('upgrades', 'tenzen_fractals_up', 'tenzen', 'portrait', 'Cackling pink and blue flame daemons splitting into smaller copies of themselves in bursts of warpfire.'),
  e('upgrades', 'tenzen_fatespinner_up', 'tenzen', 'portrait', 'A towering bird-headed sorcerer daemon with iridescent blue wings and a crooked staff, eyes of pink fire.'),
  e('upgrades', 'lasha_power_of_pain', 'lasha', 'portrait', 'A jewelled silver crown of thorns resting on a violet velvet cushion, lit by a single shaft of light.'),
  e('upgrades', 'lasha_power_of_pleasure', 'lasha', 'portrait', 'A golden goblet overflowing with glowing pink wine among scattered rose petals and pearls.'),
  e('upgrades', 'lasha_addicts_up', 'lasha', 'portrait', 'Masked revellers lounging in silks in a smoky violet opium den, dazed and ecstatic.'),
  e('upgrades', 'lasha_ravers_up', 'lasha', 'portrait', 'Lithe androgynous lilac-skinned daemons with elegant claws dancing through a smoky battlefield.'),
  e('upgrades', 'lasha_rapture_up', 'lasha', 'portrait', 'A regal four-armed horned daemon of terrible beauty, lilac skin and jewels, standing before a violet palace.'),
];

const FIGURE = 'Head-and-shoulders character portrait, centered, facing the viewer, against a dark smoky vignette background, bold silhouette that reads clearly at small size.';
const FOLLOWERS = [
  e('followers', 'xarm_cultist', 'xarm', 'square', `${FIGURE} A zealous human cultist in a crimson hood and brass mask, gripping a curved dagger.`),
  e('followers', 'xarm_warrior', 'xarm', 'square', `${FIGURE} A red-skinned horned daemon warrior with a long brass blade and burning eyes.`),
  e('followers', 'xarm_incarnation', 'xarm', 'square', `${FIGURE} A colossal winged red daemon lord in brass armour with bull-like horns, roaring.`),
  e('followers', 'gormen_cultist', 'gormen', 'square', `${FIGURE} A hooded plague monk with sickly skin and a rusty handbell, flies around him.`),
  e('followers', 'gormen_warrior', 'gormen', 'square', `${FIGURE} A one-eyed horned green-skinned plague daemon with a rusty blade.`),
  e('followers', 'gormen_incarnation', 'gormen', 'square', `${FIGURE} A gigantic bloated jolly plague lord with antlers and a wide grin.`),
  e('followers', 'tenzen_cultist', 'tenzen', 'square', `${FIGURE} A young robed apprentice sorcerer in a blue hood with glowing eyes, holding a glowing blue stone.`),
  e('followers', 'tenzen_warrior', 'tenzen', 'square', `${FIGURE} A cackling pink and blue flame daemon with long arms and a wide mouth.`),
  e('followers', 'tenzen_incarnation', 'tenzen', 'square', `${FIGURE} A bird-headed feathered sorcerer daemon lord with iridescent blue plumage and pink fire in its eyes.`),
  e('followers', 'lasha_cultist', 'lasha', 'square', `${FIGURE} A masked reveller with a purple veil and dazed, dilated eyes.`),
  e('followers', 'lasha_warrior', 'lasha', 'square', `${FIGURE} A pale lilac androgynous daemon with elegant claws and a serene, cruel smile.`),
  e('followers', 'lasha_incarnation', 'lasha', 'square', `${FIGURE} A regal horned daemon of terrible beauty with four arms, lilac skin and jewels.`),
];

const GODS = [
  e('gods', 'xarm', 'xarm', 'portrait', 'A vast armoured war god seated on a brass throne of skulls, face hidden in a horned helm, rivers of crimson and fire beneath.'),
  e('gods', 'gormen', 'gormen', 'portrait', 'An immense rotting yet benevolent god-father, bloated and grinning, enthroned in a garden of decay and swarming flies.'),
  e('gods', 'tenzen', 'tenzen', 'portrait', 'An ever-shifting cosmic sorcerer god of feathers and eyes, surrounded by labyrinths of blue and pink fire.'),
  e('gods', 'lasha', 'lasha', 'portrait', 'An alluring androgynous deity of excess, half-masked, reclining on violet silk among perfumed smoke and jewels.'),
];

const LAND = 'Painterly landscape vista, wide establishing shot, ominous sky with a faint unnatural glow on the horizon.';
const REGIONS = [
  e('regions', 'norrsund', 'world', 'landscape', `${LAND} A frozen fjord with longhouses and dragon-prowed longships under a green aurora, northern raiders on the shore.`),
  e('regions', 'talvimaa', 'world', 'landscape', `${LAND} A desolate tundra of ice and troll-haunted crags, snowbound standing stones, a blizzard rolling in.`),
  e('regions', 'volensk', 'world', 'landscape', `${LAND} A vast snowy steppe before a fortified city of onion domes and timber walls, winged lancers riding out.`),
  e('regions', 'mittelreich', 'world', 'landscape', `${LAND} A great gothic imperial city on a river, cathedrals and half-timbered houses, griffon banners on the walls.`),
  e('regions', 'normagne', 'world', 'landscape', `${LAND} A chivalric kingdom with a fairy-tale castle above vineyards, knights riding under blue and gold pennants.`),
  e('regions', 'almerida', 'world', 'landscape', `${LAND} A sun-baked coastal kingdom of white walls, a domed cathedral and galleons in the harbour.`),
  e('regions', 'toscavar', 'world', 'landscape', `${LAND} Renaissance city-states with terracotta roofs, canals and tall towers, mercenary camps outside the walls.`),
  e('regions', 'pelascos', 'world', 'landscape', `${LAND} War-torn border princedoms: ruined keeps on rocky hills, ragged banners, burned farmsteads.`),
  e('regions', 'the_barrens', 'world', 'landscape', `${LAND} Blasted badlands of red rock and volcanic smoke, crude war camps silhouetted on the ridges.`),
];

const WORLD = [
  e('world', 'normagne_heir', 'world', 'portrait', 'A young crowned heir being knighted before a fairy-tale castle, heroes gathering in shining armour.'),
  e('world', 'eastern_armistice', 'world', 'portrait', 'Envoys of two armies clasping hands over a map table in a snowy command tent, banners lowered.'),
  e('world', 'northern_heir', 'world', 'portrait', 'A fur-clad northern prince raising a sword atop a frozen cliff, his warriors cheering below.'),
  e('world', 'mittelreich_diplomacy', 'world', 'portrait', 'Diplomats in a gothic council chamber sealing treaties with wax, candlelight and tapestries.'),
  e('world', 'accelerating_doom', 'world', 'portrait', 'A great comet with a burning green tail splitting the night sky above a doomed city.'),
  e('world', 'the_chokepoint', 'world', 'portrait', 'A narrow mountain pass fortified by a stone gatehouse, soldiers with pikes holding the line.'),
  e('world', 'chaos_storm', 'world', 'portrait', 'A vortex storm of multicoloured unnatural lightning raining glowing stones down onto the land.'),
  e('world', 'central_overpopulation', 'world', 'portrait', 'A crowded medieval market city overflowing with peasants, tents sprawling beyond the walls.'),
  e('world', 'raise_the_militia', 'world', 'portrait', 'Peasants taking up pitchforks and halberds in a village square while a grizzled sergeant drills them.'),
  e('world', 'peasant_harvest', 'world', 'portrait', 'Peasants harvesting wheat with scythes under an ominous blood-red harvest moon.'),
  e('world', 'diplomatic_envoy', 'world', 'portrait', 'A mounted envoy with heraldic banners riding through a great city gate, crowds watching.'),
  e('world', 'chaos_countermeasures', 'world', 'portrait', 'Witch hunters in wide-brimmed hats searching ruins by lantern light, a ratman scout guiding them.'),
  e('world', 'great_exorcism', 'world', 'portrait', 'A procession of priests with censers and holy fire purging a village square of shadowy cultists.'),
  e('world', 'grand_muster', 'world', 'portrait', 'A vast army of knights, heroes and levies assembling on a plain beneath a sea of banners.'),
  e('world', 'ratmens_price', 'world', 'portrait', 'A hooded ratman merchant offering a glowing green stone to a nobleman in a shadowed alley.'),
  e('world', 'cleansing_wave', 'world', 'portrait', 'A wave of golden holy light sweeping across a corrupted land, dark mist fleeing before it.'),
  e('world', 'forward_scouts', 'world', 'portrait', 'Ratmen scouts peering over a rocky ridge at a distant army camp, one holding a brass spyglass.'),
  e('world', 'the_exchange', 'world', 'portrait', 'A shady trade in a candlelit cellar: a chest of glowing stones exchanged for a sack of gold.'),
  e('world', 'noble_scrutiny', 'world', 'portrait', 'Stern nobles in a gallery scrutinising a trial below, inquisitors in black at the bench.'),
];

const TOKEN = 'A single game token object, centered, isolated on a plain very dark background, studio lit, reads clearly at tiny size.';
const TOKENS = [
  e('tokens', 'chaos_stone', 'neutral', 'square', `${TOKEN} A jagged glowing warpstone crystal pulsing with teal and violet light.`),
  e('tokens', 'hero', 'world', 'square', `${TOKEN} A steel knight's helm with a golden laurel and a small heraldic plume.`),
  e('tokens', 'noble', 'world', 'square', `${TOKEN} An ornate golden signet ring and a small jewelled crown on velvet.`),
  e('tokens', 'peasant', 'neutral', 'square', `${TOKEN} A weathered straw hat resting on a pitchfork and a sheaf of wheat.`),
  e('tokens', 'ratmen', 'neutral', 'square', `${TOKEN} A hooded ratman head with glowing green eyes and whiskers.`),
  e('tokens', 'event', 'world', 'square', `${TOKEN} A wax-sealed royal proclamation scroll with a red ribbon.`),
];

const MISC = [
  e('misc', 'table', 'neutral', 'landscape', 'A dark, candlelit war table seen from above at an angle: old leather, scattered bone dice, a dagger, wax seals and wine stains, deep shadows at the edges, leaving the centre empty and dark.'),
  e('misc', 'card_back', 'neutral', 'portrait', 'An ornate occult card back: four interlocking gothic sigils in red, green, blue and purple around a central burning eye, filigree of tarnished brass on black leather, symmetrical.'),
];

export const ENTRIES = [...CARDS, ...UPGRADES, ...FOLLOWERS, ...GODS, ...REGIONS, ...WORLD, ...TOKENS, ...MISC];

export function promptFor(entry) {
  return `${entry.subject} ${STYLE.replace('ACCENT', ACCENT[entry.accent])} ${ASPECT[entry.aspect]}`;
}
