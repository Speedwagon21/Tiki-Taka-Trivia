/* Things players buy with Gold Coins. They change how a player looks in rooms and on the results
   screen and never help them win. `value` is an emoji (avatars), a frame style or a name colour
   that the game screen knows; players only ever send an item's id, so nothing they send is drawn. */
const ITEMS = {
  // Avatars: shown next to your name
  "av-boot":    { kind: "avatar", name: "Golden boots", value: "👟", price: 1500 },
  "av-gloves":  { kind: "avatar", name: "Keeper gloves", value: "🧤", price: 1500 },
  "av-net":     { kind: "avatar", name: "Back of the net", value: "🥅", price: 2000 },
  "av-rocket":  { kind: "avatar", name: "Screamer", value: "🚀", price: 3000 },
  "av-lion":    { kind: "avatar", name: "Lionheart", value: "🦁", price: 3000 },
  "av-eagle":   { kind: "avatar", name: "Eagle eye", value: "🦅", price: 3000 },
  "av-fire":    { kind: "avatar", name: "On fire", value: "🔥", price: 4000 },
  "av-goat":    { kind: "avatar", name: "The GOAT", value: "🐐", price: 6000 },
  "av-dragon":  { kind: "avatar", name: "Dragon", value: "🐉", price: 8000 },
  "av-crown":   { kind: "avatar", name: "King of the pitch", value: "👑", price: 10000 },
  "av-trophy":  { kind: "avatar", name: "Champion", value: "🏆", price: 15000 },
  // Frames: a ring around your avatar
  "fr-silver":  { kind: "frame", name: "Silver", value: "silver", price: 3000 },
  "fr-neon":    { kind: "frame", name: "Floodlight", value: "neon", price: 6000 },
  "fr-gold":    { kind: "frame", name: "Gold", value: "gold", price: 8000 },
  "fr-flame":   { kind: "frame", name: "Flame", value: "flame", price: 12000 },
  "fr-rainbow": { kind: "frame", name: "Rainbow", value: "rainbow", price: 25000 },
  // Name colours
  "nc-green":   { kind: "color", name: "Pitch green", value: "#5fd38d", price: 2000 },
  "nc-sky":     { kind: "color", name: "Sky blue", value: "#6cc4ff", price: 2000 },
  "nc-yellow":  { kind: "color", name: "Yellow card", value: "#ffd84d", price: 3000 },
  "nc-red":     { kind: "color", name: "Red card", value: "#ff6b6b", price: 3000 },
  "nc-purple":  { kind: "color", name: "Royal purple", value: "#b48cff", price: 5000 },
  "nc-gold":    { kind: "color", name: "Gold", value: "#e8c26a", price: 8000 }
};
const KINDS = { avatar: "look_avatar", frame: "look_frame", color: "look_color" };   // the only column names that reach SQL

module.exports = { ITEMS, KINDS };
