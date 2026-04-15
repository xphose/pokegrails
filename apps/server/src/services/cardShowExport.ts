import QRCode from 'qrcode'
import type Database from 'better-sqlite3'
import { config } from '../config.js'

export async function buildCardShowHtml(db: Database.Database): Promise<string> {
  const rows = db
    .prepare(
      `SELECT id, name, image_url, market_price, predicted_price, valuation_flag, pull_cost_score, desirability_score
       FROM cards WHERE valuation_flag LIKE '%UNDERVALUED%'
       ORDER BY (predicted_price - market_price) DESC LIMIT 50`,
    )
    .all() as {
    id: string
    name: string
    image_url: string | null
    market_price: number | null
    predicted_price: number | null
    valuation_flag: string | null
    pull_cost_score: number | null
    desirability_score: number | null
  }[]

  const ts = new Date().toISOString()
  const qr = await QRCode.toDataURL(config.publicAppUrl)

  const cardsHtml = rows
    .map((r) => {
      const m = r.market_price ?? 0
      const p = r.predicted_price ?? m
      const anchor = Math.max(m, p)
      const opening = (anchor * 0.80).toFixed(2)
      const ideal = (anchor * 0.87).toFixed(2)
      const maxPay = (anchor * 0.93).toFixed(2)
      return `<tr>
        <td><img src="${r.image_url || ''}" alt="" width="56"/></td>
        <td>${escapeHtml(r.name)}</td>
        <td>$${opening}</td>
        <td>$${ideal}</td>
        <td>$${maxPay}</td>
        <td>${escapeHtml(r.valuation_flag || '')}</td>
      </tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>PokéEdge — Card Show</title>
<style>
  body { font-family: system-ui, sans-serif; background:#111; color:#eee; padding:16px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { border:1px solid #333; padding:6px; text-align:left; }
  th { background:#1a1a24; }
  h1 { font-size:18px; }
  .meta { color:#888; font-size:11px; margin-bottom:12px; }
  @media print { body { background:#fff; color:#000; } th { background:#eee; } }
</style></head><body>
  <h1>PokéEdge — Top buy signals</h1>
  <p class="meta">Data refresh: ${escapeHtml(ts)} · Open live dashboard for spot checks.</p>
  <img src="${qr}" alt="QR" width="96" height="96"/>
  <table>
    <thead><tr><th>Art</th><th>Card</th><th>Opening</th><th>Ideal</th><th>Max pay</th><th>Flag</th></tr></thead>
    <tbody>${cardsHtml}</tbody>
  </table>
</body></html>`
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
