// Bookmarklet: rewrites Ruin card/region/power/follower names in the DOM
// to their original Chaos in the Old World names. Uses a MutationObserver
// so React re-renders are caught. Reload the page to revert.
//
// Install:
//   1. Right-click bookmarks bar → Add page
//   2. Name: "Ruin → CitOW"
//   3. URL: copy everything between BOOKMARKLET_START / BOOKMARKLET_END below,
//      including the leading `javascript:`
//
// Chrome strips `javascript:` when pasted directly into the address bar; the
// "Add page" dialog preserves it. If a site's CSP blocks inline scripts the
// bookmarklet may be rejected — the game client currently has no such CSP.

// ─── BOOKMARKLET_START ──────────────────────────────────────────────────────
// javascript:(function(){const M={"Normagne Heir":"Bretonnian Knights","Eastern Armistice":"Dark Elf Corsairs","Northern Heir":"Dwarf Trollslayers","Mittelreich Diplomacy":"Electors Sue for Peace","Accelerating Doom":"Franz's Decree","The Chokepoint":"Greenskins Invade","Chaos Storm":"Meteor Showers","Central Overpopulation":"Norse Reavers","Raise the Militia":"Peasant Uprising","Peasant Harvest":"Plunged into Chaos","Diplomatic Envoy":"Road Wardens","Chaos Countermeasures":"Skavengers","Great Exorcism":"Teclis Aids the Empire","Grand Muster":"The Crusade is Come","Ratmen's Price":"The Horned One's Due","Cleansing Wave":"The Grail is Found","Forward Scouts":"Up From Skavenblight","The Exchange":"Warpstone Discovery","Noble Scrutiny":"Witch Hunters","The Barrens":"Badlands","Normagne":"Bretonnia","Mittelreich":"The Empire","Almerida":"Estalia","Volensk":"Kislev","Norrsund":"Norsca","Pelascos":"Border Princes","Toscavar":"Tilea","Talvimaa":"Troll Country","Chaos Stone":"Warpstone","Ratmen":"Skaven","Xarm":"Khorne","Gormen":"Nurgle","Tenzen":"Tzeentch","Lasha":"Slaanesh","xarm":"khorne","gormen":"nurgle","tenzen":"tzeentch","lasha":"slaanesh","Heartseekers":"Bloodsworn","Heartrippers":"Bloodletters","Heartgrinder":"Bloodthirster","Plaguecarriers":"Lepers","Plaguebringers":"Plaguebearers","Plaguefather":"Great Unclean One","Apprentices":"Acolytes","Fractals":"Horrors","Fatespinner":"Lord of Change","Addicts":"Seductresses","Ravers":"Daemonettes","The Rapture":"Keeper of Secrets","War Frenzy":"Blood Frenzy","War Cry":"Battle Cry","Carnage Trap":"Field of Carnage","Ritual Death":"Ritual Slaying","The Red Throne":"The Skull Throne","Bloody Rebirth":"Reborn in Blood","Call to War":"The Blood God's Call","Pestilent Aura":"Plague Aura","Pestilent Touch":"Plague Touch","Pandemic":"Influenza","Rain of Bile":"Rain of Pus","Power of Decay":"Power of Decay","Decay":"All Things Decay","Vile Consumption":"A Great Foul Consumption","Inevitable Rot":"The Final Rotting","Death's Perfume":"The Stench of Death","Changer of Fate":"Changer of Ways","Fate Shield":"Warp Shield","The Meddling of Rats":"The Meddling of Skaven","Stasis Web":"Temporal Stasis","Persistence Matrix":"The Persistence of Change","Shimmer":"Dazzle","Siphon Power":"Drain Power","Hollow Pact":"Abyssal Pact","Depraved Infiltration":"Perverse Infiltration","Sweet Lies":"Insidious Lies","Hidden Influence":"Dark Influence","Narcotic Musk":"Soporific Musk","Ecstasy":"Field of Ecstasy","Debauched Royalty":"Degenerate Royalty"};const k=Object.keys(M).sort((a,b)=>b.length-a.length),e=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),r=new RegExp('\\b(?:'+k.map(e).join('|')+')\\b','g'),S=new Set(['SCRIPT','STYLE','TEXTAREA','INPUT']);function w(n){if(n.nodeType===3){const t=n.nodeValue,u=t.replace(r,m=>M[m]);if(u!==t)n.nodeValue=u;}else if(n.nodeType===1&&!S.has(n.tagName)){for(const c of n.childNodes)w(c);}}w(document.body);if(window.__ruinObs)window.__ruinObs.disconnect();window.__ruinObs=new MutationObserver(ms=>{for(const m of ms){for(const n of m.addedNodes)w(n);if(m.type==='characterData')w(m.target);}});window.__ruinObs.observe(document.body,{childList:true,subtree:true,characterData:true});console.log('Ruin \u2192 original names active. Reload to revert.');})();
// ─── BOOKMARKLET_END ────────────────────────────────────────────────────────

// Readable source — edit this, then re-minify into the BOOKMARKLET block above.

(function () {
  const MAP = {
    // World cards
    "Normagne Heir": "Bretonnian Knights",
    "Eastern Armistice": "Dark Elf Corsairs",
    "Northern Heir": "Dwarf Trollslayers",
    "Mittelreich Diplomacy": "Electors Sue for Peace",
    "Accelerating Doom": "Franz's Decree",
    "The Chokepoint": "Greenskins Invade",
    "Chaos Storm": "Meteor Showers",
    "Central Overpopulation": "Norse Reavers",
    "Raise the Militia": "Peasant Uprising",
    "Peasant Harvest": "Plunged into Chaos",
    "Diplomatic Envoy": "Road Wardens",
    "Chaos Countermeasures": "Skavengers",
    "Great Exorcism": "Teclis Aids the Empire",
    "Grand Muster": "The Crusade is Come",
    "Ratmen's Price": "The Horned One's Due",
    "Cleansing Wave": "The Grail is Found",
    "Forward Scouts": "Up From Skavenblight",
    "The Exchange": "Warpstone Discovery",
    "Noble Scrutiny": "Witch Hunters",

    // Regions
    "The Barrens": "Badlands",
    "Normagne": "Bretonnia",
    "Mittelreich": "The Empire",
    "Almerida": "Estalia",
    "Volensk": "Kislev",
    "Norrsund": "Norsca",
    "Pelascos": "Border Princes",
    "Toscavar": "Tilea",
    "Talvimaa": "Troll Country",

    // World tokens
    "Chaos Stone": "Warpstone",
    "Ratmen": "Skaven",

    // Powers (both cases — log messages use lowercase)
    "Xarm": "Khorne",
    "Gormen": "Nurgle",
    "Tenzen": "Tzeentch",
    "Lasha": "Slaanesh",
    "xarm": "khorne",
    "gormen": "nurgle",
    "tenzen": "tzeentch",
    "lasha": "slaanesh",

    // Followers
    "Heartseekers": "Bloodsworn",
    "Heartrippers": "Bloodletters",
    "Heartgrinder": "Bloodthirster",
    "Plaguecarriers": "Lepers",
    "Plaguebringers": "Plaguebearers",
    "Plaguefather": "Great Unclean One",
    "Apprentices": "Acolytes",
    "Fractals": "Horrors",
    "Fatespinner": "Lord of Change",
    "Addicts": "Seductresses",
    "Ravers": "Daemonettes",
    "The Rapture": "Keeper of Secrets",

    // Khorne chaos cards
    "War Frenzy": "Blood Frenzy",
    "War Cry": "Battle Cry",
    "Carnage Trap": "Field of Carnage",
    "Ritual Death": "Ritual Slaying",
    "The Red Throne": "The Skull Throne",
    "Bloody Rebirth": "Reborn in Blood",
    "Call to War": "The Blood God's Call",

    // Nurgle chaos cards
    "Pestilent Aura": "Plague Aura",
    "Pestilent Touch": "Plague Touch",
    "Pandemic": "Influenza",
    "Rain of Bile": "Rain of Pus",
    // Identity — shields "Decay" below from matching inside the upgrade name.
    // Longest-match-first ordering means "Power of Decay" wins over "Decay".
    "Power of Decay": "Power of Decay",
    "Decay": "All Things Decay",
    "Vile Consumption": "A Great Foul Consumption",
    "Inevitable Rot": "The Final Rotting",
    "Death's Perfume": "The Stench of Death",

    // Tzeentch chaos cards ("Teleport" unchanged between versions — omitted)
    "Changer of Fate": "Changer of Ways",
    "Fate Shield": "Warp Shield",
    "The Meddling of Rats": "The Meddling of Skaven",
    "Stasis Web": "Temporal Stasis",
    "Persistence Matrix": "The Persistence of Change",
    "Shimmer": "Dazzle",
    "Siphon Power": "Drain Power",

    // Slaanesh chaos cards
    "Hollow Pact": "Abyssal Pact",
    "Depraved Infiltration": "Perverse Infiltration",
    "Sweet Lies": "Insidious Lies",
    "Hidden Influence": "Dark Influence",
    "Narcotic Musk": "Soporific Musk",
    "Ecstasy": "Field of Ecstasy",
    "Debauched Royalty": "Degenerate Royalty",
  };

  const keys = Object.keys(MAP).sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b(?:" + keys.map(esc).join("|") + ")\\b", "g");
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

  function walk(n) {
    if (n.nodeType === 3) {
      const t = n.nodeValue;
      const r = t.replace(re, (m) => MAP[m]);
      if (r !== t) n.nodeValue = r;
    } else if (n.nodeType === 1 && !SKIP.has(n.tagName)) {
      for (const c of n.childNodes) walk(c);
    }
  }

  walk(document.body);
  if (window.__ruinObs) window.__ruinObs.disconnect();
  window.__ruinObs = new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes) walk(n);
      if (m.type === "characterData") walk(m.target);
    }
  });
  window.__ruinObs.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  console.log("Ruin → original names active. Reload to revert.");
})();
