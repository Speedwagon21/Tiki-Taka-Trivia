/* Things players buy with Gold Coins. Everyone in a room sees them; none of them help anyone win.
   card:        the design of your player card (shown in rooms, on the results screen and in your account)
   celebration: what takes over everyone's screen when you win a match
   color:       how your name looks ("anim-" values are animated)
   `value` names a style the game screen knows; players only ever send an item's id, so nothing they send is drawn.
   `until` (optional) is the last day a limited item can be bought; whoever bought it keeps it. */
const ITEMS = {
  // Player cards (everyone starts with Bronze)
  "card-silver":   { kind: "card", name: "Silver", value: "silver", rarity: "common", price: 2000 },
  "card-gold":     { kind: "card", name: "Gold", value: "gold", rarity: "rare", price: 5000 },
  "card-night":    { kind: "card", name: "Floodlights", value: "night", rarity: "epic", price: 10000 },
  "card-holo":     { kind: "card", name: "Holo special", value: "holo", rarity: "epic", price: 15000 },
  "card-icon":     { kind: "card", name: "Icon", value: "icon", rarity: "legendary", price: 30000 },
  "card-derby":    { kind: "card", name: "Winter Derby", value: "derby", rarity: "legendary", price: 20000, until: "2027-01-15" },
  // Celebrations
  "cel-confetti":  { kind: "celebration", name: "Confetti cannon", value: "confetti", rarity: "common", price: 2500 },
  "cel-fireworks": { kind: "celebration", name: "Fireworks", value: "fireworks", rarity: "rare", price: 6000 },
  "cel-trophy":    { kind: "celebration", name: "Trophy lift", value: "trophy", rarity: "epic", price: 12000 },
  "cel-net":       { kind: "celebration", name: "Net buster", value: "net", rarity: "epic", price: 15000 },
  "cel-goldrain":  { kind: "celebration", name: "Golden rain", value: "goldrain", rarity: "legendary", price: 30000 },
  // Name styles
  "nc-green":      { kind: "color", name: "Pitch green", value: "#5fd38d", rarity: "common", price: 2000 },
  "nc-sky":        { kind: "color", name: "Sky blue", value: "#6cc4ff", rarity: "common", price: 2000 },
  "nc-red":        { kind: "color", name: "Red card", value: "#ff6b6b", rarity: "common", price: 3000 },
  "nc-purple":     { kind: "color", name: "Royal purple", value: "#b48cff", rarity: "rare", price: 5000 },
  "nc-fire":       { kind: "color", name: "On fire", value: "anim-fire", rarity: "epic", price: 12000 },
  "nc-shimmer":    { kind: "color", name: "Gold shimmer", value: "anim-gold", rarity: "legendary", price: 20000 }
};
const KINDS = { card: "look_card", celebration: "look_celebration", color: "look_color" };   // the only column names that reach SQL

/* Whether an item can still be bought on this date (limited items leave the shop after `until`) */
const onSale = (item, now = new Date()) => !item.until || now.toISOString().slice(0, 10) <= item.until;

module.exports = { ITEMS, KINDS, onSale };
