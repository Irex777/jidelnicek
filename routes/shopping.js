// ═══════════════════════════════════════════════════════════════════════
// Shopping list routes — aggregated ingredient list from meal plans
// ═══════════════════════════════════════════════════════════════════════

const { queryOne, queryAll, runDb } = require('../db');

function register(app) {
  app.get('/api/shopping-list/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Profil nenalezen' });

    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to query params required' });

    const cached = queryOne('SELECT * FROM shopping_lists WHERE user_id = ? AND date_from = ? AND date_to = ?', [userId, from, to]);
    if (cached) return res.json({ items: JSON.parse(cached.items_json), from, to });

    const plans = queryAll('SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, from, to]);
    if (!plans.length) return res.json({ items: [], from, to });

    const normUnit = (u) => {
      const l = (u || 'ks').toLowerCase();
      if (['lžíce', 'lžičky', 'lžička', 'lžiček', 'polévková lžíce'].includes(l)) return 'lžíce';
      if (['stroužek', 'stroužky'].includes(l)) return 'stroužky';
      return l;
    };

    const parseIng = (s) => {
      const raw = s.trim();
      let m = raw.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?$/i);
      if (m) return { name: m[1].trim(), qty: parseFloat(m[2].replace(',', '.')), unit: normUnit(m[3] || 'ks') };
      m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?\s+(.+)$/i);
      if (m) return { name: m[3].trim(), qty: parseFloat(m[1].replace(',', '.')), unit: normUnit(m[2] || 'ks') };
      return { name: raw, qty: 0, unit: '' };
    };

    const categorize = (name) => {
      const n = name.toLowerCase();
      const cats = [
        [/maso|kuře|krůt|vepřov|hověz|losos|tuňák|candát|treska|slanina|šunka|mleté/, '🥩 Maso a ryby'],
        [/sýr|eidam|parmaz|cottage|lučina|tvaroh|mozzarell/, '🧀 Sýry'],
        [/jogurt|mléko|smetana|kefír/, '🥛 Mléčné'],
        [/vejce/, '🥚 Vejce'],
        [/chléb|chleb|toast|knäckebrot|tortilla|polenta/, '🍞 Pečivo'],
        [/rýže|těstovin|kuskus|quinoa|pohanka|vločky|mouka|knedlík/, '🌾 Obiloviny'],
        [/banán|jablk|jahod|borůvk|malin|hrozn|ovoc|citrus|citrón|pomeranč/, '🍎 Ovoce'],
        [/okurk|rajč|paprik|brokolic|špenát|cuket|salát|ředkvič|mrkev|cibul|oliv|zelí|luštěnin|fazol|hrášek|zelenin|avokád/, '🥬 Zelenina'],
        [/protein|whey|srvát/, '💪 Protein'],
        [/olej|máslo|med|sirup|arašídové máslo/, '🧈 Tuky a sladidla'],
        [/omáčka|protlak|dresink|sójo|ocet|kření|koření|bylink|sůl|pepř/, '🧂 Koření a omáčky'],
        [/tyčink|pudink/, '🍫 Sladkosti'],
      ];
      for (const [re, cat] of cats) { if (re.test(n)) return cat; }
      return '📦 Ostatní';
    };

    const baseName = (n) => n.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/\b(syrov[éý]|čerstv[éeý]|mražen[éeý]|grilovan[éeý]|vařen[éeý]|pečen[éeý]|celozrnn[éeý]|odtučněn[éeý]|polotučn[éeý]|libov[éeý]|hladké|na ozdobu|bez kůže|ve vlastní šťávě)\b/gi, '').replace(/\s+/g, ' ').trim();

    const merged = {};
    plans.forEach(planRow => {
      const dayMeals = JSON.parse(planRow.meals_json);
      Object.values(dayMeals).forEach(meal => {
        (meal.ingredients || []).forEach(raw => {
          const p = parseIng(raw);
          const bn = baseName(p.name);
          let bestKey = null, bestScore = 0;
          for (const existingKey of Object.keys(merged)) {
            const eb = baseName(existingKey);
            if (eb === bn) { bestKey = existingKey; bestScore = 1; break; }
            if (eb.length > 3 && bn.length > 3) {
              if (eb.includes(bn) || bn.includes(eb)) {
                const score = Math.min(eb.length, bn.length) / Math.max(eb.length, bn.length);
                if (score > bestScore && score > 0.5) { bestScore = score; bestKey = existingKey; }
              }
            }
          }
          if (bestKey && merged[bestKey].unit === p.unit) {
            merged[bestKey].qty += p.qty;
          } else if (bestKey && p.qty > 0) {
            if (!merged[bestKey].also) merged[bestKey].also = [];
            merged[bestKey].also.push(`${p.qty} ${p.unit}`);
          } else {
            merged[p.name.toLowerCase()] = { name: p.name, qty: p.qty, unit: p.unit, category: categorize(p.name), checked: false };
          }
        });
      });
    });

    const list = Object.values(merged).map(item => {
      let display = item.name;
      if (item.qty > 0) {
        const q = item.qty % 1 === 0 ? item.qty : item.qty.toFixed(1).replace('.0', '');
        display += ` ${q} ${item.unit}`;
      }
      if (item.also) display += ` + ${item.also.join(' + ')}`;
      return { ...item, display };
    }).sort((a, b) => a.category.localeCompare(b.category, 'cs') || a.name.localeCompare(b.name, 'cs'));

    runDb('INSERT INTO shopping_lists (user_id, date_from, date_to, items_json) VALUES (?, ?, ?, ?)', [userId, from, to, JSON.stringify(list)]);
    res.json({ items: list, from, to });
  });
}

module.exports = { register };
