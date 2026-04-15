import type Database from 'better-sqlite3'

const CHARACTERS = [
  'Pikachu', 'Charizard', 'Mewtwo', 'Eevee', 'Gengar',
  'Umbreon', 'Rayquaza', 'Blastoise', 'Venusaur', 'Lugia',
  'Gardevoir', 'Greninja', 'Lucario', 'Dragonite', 'Snorlax',
  'Gyarados', 'Tyranitar', 'Salamence', 'Metagross', 'Garchomp',
]

const RARITIES = [
  'Special Illustration Rare', 'Illustration Rare', 'Ultra Rare',
  'Double Rare', 'Full Art', 'Rare Holo', 'Rare', 'Uncommon', 'Common',
]

const CARD_TYPES = [
  'Special Illustration Rare', 'Illustration Rare', 'Ultra Rare',
  'Double Rare', 'Full Art', 'Rare Holo', 'Rare', 'Uncommon', 'Common',
]

function seededRandom(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

export function seedAnalyticsFixtures(db: Database.Database, cardCount = 100, historyDays = 180) {
  const rng = seededRandom(42)

  db.prepare(`INSERT OR IGNORE INTO sets (id, name, release_date, total_cards, last_updated)
    VALUES ('test-sv1', 'Test Scarlet & Violet', '2023-03-31', 198, datetime('now'))`).run()
  db.prepare(`INSERT OR IGNORE INTO sets (id, name, release_date, total_cards, last_updated)
    VALUES ('test-sv2', 'Test Paldea Evolved', '2023-06-09', 193, datetime('now'))`).run()
  db.prepare(`INSERT OR IGNORE INTO sets (id, name, release_date, total_cards, last_updated)
    VALUES ('test-sv3', 'Test Obsidian Flames', '2023-08-11', 197, datetime('now'))`).run()

  const insertCard = db.prepare(`
    INSERT OR IGNORE INTO cards (
      id, name, set_id, rarity, card_type, character_name, image_url,
      market_price, predicted_price, pull_cost_score, desirability_score,
      artwork_hype_score, char_premium_score, reddit_buzz_score, trends_score,
      ebay_median, valuation_flag, annual_growth_rate, future_value_12m, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)

  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO price_history (card_id, timestamp, tcgplayer_market, tcgplayer_low)
    VALUES (?, ?, ?, ?)
  `)

  const insertPullRate = db.prepare(`
    INSERT OR IGNORE INTO pull_rates (set_id, rarity_tier, pull_rate_denominator, cards_in_rarity_slot)
    VALUES (?, ?, ?, ?)
  `)

  for (const setId of ['test-sv1', 'test-sv2', 'test-sv3']) {
    insertPullRate.run(setId, 'Special Illustration Rare', 400, 6)
    insertPullRate.run(setId, 'Illustration Rare', 80, 12)
    insertPullRate.run(setId, 'Ultra Rare', 30, 20)
    insertPullRate.run(setId, 'Double Rare', 12, 15)
    insertPullRate.run(setId, 'Rare Holo', 4, 25)
  }

  const sets = ['test-sv1', 'test-sv2', 'test-sv3']

  for (let i = 0; i < cardCount; i++) {
    const charIdx = i % CHARACTERS.length
    const rarityIdx = Math.floor(rng() * RARITIES.length)
    const setId = sets[i % sets.length]
    const character = CHARACTERS[charIdx]
    const rarity = RARITIES[rarityIdx]
    const cardType = CARD_TYPES[rarityIdx]

    const basePrice = 0.5 + rng() * 80
    const pullScore = 1 + rng() * 9
    const desScore = 1 + rng() * 9
    const artScore = 1 + rng() * 9
    const charScore = 1 + rng() * 9
    const predicted = basePrice * (0.7 + rng() * 0.6)
    const reddit = rng() * 15
    const trends = 2 + rng() * 8
    const ebay = basePrice * (0.85 + rng() * 0.3)
    const growth = -0.1 + rng() * 0.4
    const future12m = basePrice * (1 + growth)

    const ratio = basePrice / (predicted || 1)
    let flag = '🟡 FAIRLY VALUED'
    if (ratio < 0.8) flag = '🟢 UNDERVALUED — BUY SIGNAL'
    else if (ratio > 1.25) flag = '🔴 OVERVALUED'

    const cardId = `test-${setId}-${String(i + 1).padStart(3, '0')}`

    insertCard.run(
      cardId,
      `${character} ex`,
      setId,
      rarity,
      cardType,
      character,
      `https://example.com/cards/${cardId}.png`,
      basePrice,
      predicted,
      pullScore,
      desScore,
      artScore,
      charScore,
      reddit,
      trends,
      ebay,
      flag,
      growth,
      future12m,
    )

    let price = basePrice * (0.5 + rng() * 0.5)
    const now = Date.now()
    for (let d = historyDays; d >= 0; d--) {
      const drift = (rng() - 0.48) * 0.04
      price = Math.max(0.25, price * (1 + drift))

      if (i < 3 && d === 30) {
        price *= 1.5
      }

      const ts = new Date(now - d * 86_400_000).toISOString().split('T')[0]
      insertHistory.run(cardId, ts, price, price * 0.9)
    }
  }
}
